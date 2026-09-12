# Frontier quality gate

An **automatic, bounded** frontier-model review loop for agent-written pull
requests. It is separate from the free-form/manual `@openreview` agent: the
manual path reviews and edits code, the automatic gate **judges** a solution.

```
PR
→ deterministic (free) eligibility gate
→ wait for configured required CI
→ bounded frontier review #1
→ PASS, or compact actionable findings
→ originating agent fixes + tests + pushes        ($0, any number of pushes)
→ explicit `frontier-ready-final` label
→ delta-only frontier review #2
→ PASS or BLOCK
→ after BLOCK: repair push, then free deterministic resolution (0 model calls)
```

**Hard invariant: at most two paid frontier calls per review cycle.** No code
path can make a third call — a new cycle requires the explicit
`frontier-new-cycle` label.

The goal is maximum improvement in solution quality per frontier dollar, not
maximum review coverage. Most PRs must cost $0.

## Where the code lives

| Concern                         | File                                                  |
| ------------------------------- | ----------------------------------------------------- |
| Deterministic gate              | `lib/frontier/gate.ts`                                |
| Bounded review packet           | `lib/frontier/packet.ts`                              |
| Direct structured model call    | `lib/frontier/model.ts`                               |
| Cycle state machine / invariant | `lib/frontier/engine.ts`                              |
| Spend guard                     | `lib/frontier/budget.ts`                              |
| Durable state keys              | `lib/frontier/store.ts`                               |
| GitHub adapter                  | `lib/frontier/github.ts`, `lib/frontier/octokit.ts`   |
| Webhook routing                 | `lib/webhook-planner.ts`, `app/api/webhooks/route.ts` |
| Durable workflow                | `workflow/frontier.ts`                                |

## 1. Automatic path vs manual path

`lib/webhook-planner.ts` is a pure function that decides, per delivery, whether
an event belongs to the automatic gate or to the existing Chat SDK adapter.
Both paths share a single GitHub App, webhook endpoint, and state adapter.

Claimed by the automatic gate:

- `pull_request` — `opened`, `reopened`, `ready_for_review`, `synchronize`
- `pull_request` — `labeled`, only for `frontier-*` labels
- `check_run` — `completed`

Everything else (`issue_comment` mentions, review-comment replies, reactions)
continues to the manual `@openreview` path unchanged. Draft PRs and unrelated
labels are ignored. Signature verification happens before routing, so an
unverified body never reaches either path.

## 2. Deterministic gate

`evaluateGate` uses observable signals only. It never infers intent from source
code, and it never uses LOC or file-count thresholds.

Review signals (weights sum against `threshold`, default 5):

| Signal                                                 | Weight |
| ------------------------------------------------------ | ------ |
| prompts / agent definitions / orchestration            | 5      |
| benchmark / evaluator / scorer / verifier logic        | 5      |
| model / provider / routing / fallback / context policy | 5      |
| auth / security / destructive operations               | 6      |
| requirements / specs / operator instructions           | 4      |
| CI / release / deployment gates                        | 4      |
| persistence / migrations / concurrency / queues        | 4      |
| external API / schema / webhook contracts              | 4      |
| dependency manifests                                   | 3      |
| runtime code without corresponding tests               | 5      |

Zero-token skips: `always_review` never applies, and **every** changed file is
an ordinary doc, asset, lockfile, generated file, or an empty diff. Requirement
and spec documents are deliberately _not_ ordinary docs.

Because most code changes include runtime files without matching tests, the
practical skip set is: docs/asset/lockfile-only PRs, plus anything the repo
explicitly lists under `never_review`.

## 3. Required CI gates the spend

Before review #1 the engine resolves the repository's **configured required
checks** (branch-protection required status checks, or `FRONTIER_REQUIRED_CHECKS`
as an explicit override) and inspects only those:

| Required CI state         | Behaviour                                         |
| ------------------------- | ------------------------------------------------- |
| failing                   | `frontier-quality = neutral`, **0 model calls**   |
| pending / not yet created | `frontier-quality` in progress, **0 model calls** |
| green                     | review proceeds                                   |

Optional bots, preview deploys and unrelated third-party checks never block the
review. Waiting is driven by webhook events, not by polling a model.

## 4. Review packet

The packet sends intent + interfaces + evidence + changed implementation:

- repo / PR / base SHA / head SHA, PR title and body
- linked issue when the PR body references one
- gate reasons and required-CI evidence
- complete changed-file list and a bounded diff
- up to 6 local context files, 4000 chars each
- for review #2: the original findings plus a delta diff

Credential-shaped values are redacted. Caps (all overridable by env):

```
MAX_PACKET_CHARS=50000       MAX_DIFF_CHARS=35000
MAX_CONTEXT_FILES=6          MAX_CONTEXT_PER_FILE_CHARS=4000
MAX_PR_BODY_CHARS=4000       MAX_LINKED_ISSUE_CHARS=5000
MAX_OUTPUT_TOKENS=3000
```

A truncated diff is always marked with an explicit banner — truncation is never
silent. If the raw diff is more than 10× the diff cap, or more than 80 files
change, the packet is refused as `needs_manual_review` instead of being sent
unrepresentative.

## 5. Model call

One direct, non-streaming OpenRouter call:

```
model:      z-ai/glm-5.3
reasoning:  { effort: "low", exclude: true }
provider:   { require_parameters: true }
max_tokens: 3000
tools:      none
```

Structured output is a strict JSON schema derived from a Zod schema; the
response is re-validated and capped at 5 findings. An empty `changes_required`
verdict is coerced to `pass`. At most one retry, and only for transient
statuses (408/409/425/429/5xx) or aborts.

Findings have the shape:

```ts
type FrontierFinding = {
  id: string;
  severity: "P0" | "P1" | "P2" | "P3";
  category: string;
  path?: string;
  line?: number;
  problem: string;
  impact: string;
  required_fix: string;
  verification: string;
};
```

## 6. Labels and check conclusions

| Label                  | Effect                                                      |
| ---------------------- | ----------------------------------------------------------- |
| `frontier-review`      | force a review for this PR regardless of score              |
| `frontier-ready-final` | arm and run the single delta review #2                      |
| `frontier-new-cycle`   | after a blocked cycle, explicitly start a new bounded cycle |

| `frontier-quality` conclusion | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| success                       | skipped (low value), a review passed, or a BLOCK later resolved for free |
| action_required               | findings to fix, budget exhausted, or manual review needed               |
| neutral                       | required CI failing; nothing was spent                                   |
| failure                       | review #2 left blocking P0/P1/P2 findings                                |

## 7. Durable state is required

Every spend invariant — the per-cycle review limit, paid-call idempotency,
delivery dedup and the daily/monthly ledger — is enforced through the state
store. On an ephemeral store a cold start sees empty state, so a redelivered or
retried event could run another paid review and reset the budgets.

The gate therefore **fails closed when `REDIS_URL` is not configured**: it writes
a neutral `frontier-quality` check explaining that durable state is missing and
spends nothing. Missing configuration can never become unbounded spend.

## 8. State, idempotency and spend

Two reviews per cycle is enforced by `reviewCount` plus an idempotency key of
`repo + PR + cycle_id + review_number + reviewed_sha + packet_hash`. Duplicate
GitHub deliveries are deduplicated by delivery id, and a per-PR lock serialises
concurrent events, so duplicate or racing events cannot duplicate spend.

```
FRONTIER_MAX_REVIEWS_PER_CYCLE=2     (clamped to 2, cannot be raised)
FRONTIER_MAX_OUTPUT_TOKENS=3000
FRONTIER_MAX_PACKET_CHARS=50000
FRONTIER_DAILY_BUDGET_USD=5
FRONTIER_MONTHLY_BUDGET_USD=50
FRONTIER_MAX_CALL_USD=0.5            (floor for the per-review reservation, > 0)
FRONTIER_INPUT_USD_PER_MTOK=1.4      (judge model input price)
FRONTIER_OUTPUT_USD_PER_MTOK=4.4     (judge model output price)
FRONTIER_ENABLED=true
FRONTIER_MODEL=z-ai/glm-5.3
FRONTIER_REQUIRED_CHECKS=            (optional override, comma separated)
```

The ceilings are **hard bounds**, not advisory. Before a review runs the engine
reserves `FRONTIER_MAX_CALL_USD` against both the daily and the monthly ledger
and refuses the review unless the remaining allowance can cover it; after the
call the reservation is reconciled to the real billed cost. A call whose real
cost cannot be determined keeps its reservation (conservative).

The reservation is not a magic constant: it is derived from the configured
packet cap, the output cap and the judge model's configured price per million
tokens (`FRONTIER_*_USD_PER_MTOK`), plus a system-prompt allowance, so it scales
with the caps that actually determine the billable size of a request.
`FRONTIER_MAX_CALL_USD` is a floor an operator can raise.

At the default caps and prices the derived reservation is ~$0.30, so the
`FRONTIER_MAX_CALL_USD` floor of $0.50 governs, against an observed real cost of
roughly $0.02-0.03 per review on `z-ai/glm-5.3`. The reservation bounds the
worst case rather than the expected case, so keep the daily ceiling comfortably
above it.

A token can never be shorter than one byte, and one character is at most four
UTF-8 bytes, so the input estimate reserves four bytes per permitted character.
A per-character ratio under-reserves on punctuation-heavy, code-heavy,
non-English or emoji content under byte-level tokenisation. The reservation is
therefore deliberately pessimistic and is reconciled down to the real billed
cost after each review.

Reservations carry an identity: the reservation record is deleted when it is
claimed, before the ledger is adjusted, so an interrupted reconciliation can
never be retried into a second adjustment — a partial failure leaves the ledger
over-counted, never under-counted, and a repeated reconciliation is a no-op. Every ledger mutation — reserve and reconcile — runs under a single
dedicated spend lock, because the daily and monthly keys are shared across PRs
and the per-PR lock alone would let concurrent reviews (or reconciliations) lose
increments and overshoot. `FRONTIER_MAX_CALL_USD` must be greater than zero, and
a state store without distributed locking is refused rather than trusted
implicitly; both fail closed with zero model calls.

The guard runs **before** the request and fails closed: if the ledger cannot be
read, or a budget is 0, or the remaining allowance cannot cover one review, the
review is skipped with `0` calls and no fallback model.

Exact OpenRouter usage (`prompt_tokens`, `completion_tokens`, `cost`, model) is
recorded per review in the PR state and in daily/monthly spend ledgers.

## 9. Repo configuration

Optional `.github/frontier-review.yml` (or `.yaml`, or `.github/frontier.yml`):

```yaml
frontier:
  enabled: true
  threshold: 5
  always_review: ["src/agents/**", "benchmarks/**"]
  never_review: ["generated/**"]
```

Malformed configuration falls back to defaults rather than breaking the
webhook.

## 10. GitHub App permissions

The automatic path needs, in addition to the existing manual-path permissions:

- **Checks: Read & write** — to create and update `frontier-quality`
- **Pull requests: Read & write** — to read diffs and post findings
- Subscribed events: **Pull request**, **Check run** (plus the existing
  issue-comment and review-comment events)

Granting these is a **two-step** process: the App change raises a permission
review request, and the installation keeps its old permissions until that
request is accepted (until then, check-run creation returns `403`).

Deployment, the complete environment-variable list, the invocation handle and
the operational traps are in
[`frontier-quality-gate-operations.md`](./frontier-quality-gate-operations.md).

## 11. Tests

`bun test` covers the deterministic gate, packet caps and redaction, budget
guard, response parsing, request pinning, webhook routing (including manual
`@openreview` regression) and acceptance scenarios A–J:

| Scenario                    | Expectation                                       |
| --------------------------- | ------------------------------------------------- |
| A trivial PR                | skipped, 0 calls                                  |
| B meaningful clean PR       | 1 call, pass                                      |
| C seeded defect then repair | 2 calls, repair pushes free, review #2 delta-only |
| D ten repair pushes         | 0 additional calls                                |
| E final repair still wrong  | BLOCK, 2 calls, later pushes free                 |
| F explicit new cycle        | only `frontier-new-cycle` restarts spend          |
| G duplicate webhook         | deduplicated, 0 extra calls                       |
| H required CI failure       | 0 calls; resumes when CI goes green               |
| I optional check pending    | review still proceeds                             |
| J budget exhausted          | fails before the request, 0 calls                 |
| K BLOCK then repair         | free resolution, 0 calls, check clears            |
| L BLOCK then no-op repair   | stays blocked, 0 calls                            |

## 12 After a BLOCK: free deterministic resolution

A cycle buys at most two paid reviews, so once review #2 BLOCKs the PR cannot
buy a third. Leaving a required check red forever would strand the work, so the
gate verifies the **repair** deterministically instead - still with **0 model
calls**:

1. The blocked cycle records the reviewed SHA and the blocking findings.
2. A repair push is compared against that SHA (`compare/{base}...{head}`).
3. Every blocking finding must name a file, and that file must appear in the
   repair delta.
4. The repository's required CI must be green (the `frontier-quality` check
   itself is excluded, as always).

If all four hold, `frontier-quality` is written as **success** and the PR can
merge; the gate posts the resolution map as the audit trail. Otherwise the check
stays **failure**, and its output lists exactly which findings are unresolved
and why.

```
| Finding | Severity | File | Status | Evidence |
| F1 | P1 | `lib/model.ts` | addressed | `lib/model.ts` changed and required CI is green |
| F2 | P0 | - | unresolved | no file path; not deterministically verifiable |
```

What this does and does not prove: it proves the flagged file changed and CI
passed. It is **not** a semantic re-review - that was review #2's job. A finding
that names no file (an architectural or judgement finding) can never be
auto-resolved, so the PR stays blocked and the operator decides: fix it by hand
and re-run, or buy a new cycle with `frontier-new-cycle`.

The pass is idempotent: the check is rewritten only when the map changes,
because each write produces a `check_run` event that re-enters the gate.

## Not yet covered

- semantic verification of a repair after a BLOCK (resolution is deterministic:
  file changed + CI green, not a re-review)
- a _passed_ cycle that receives a further push is not re-verified; the new SHA
  has no `frontier-quality` run until a new cycle is started
- automatic PASS_WITH_BACKLOG issue creation, and P2/P3 backlog deduplication
- dashboards and ROI analytics beyond the recorded spend ledgers
- semantic packet retrieval, and holistic "primary user journey changed"
  judgements (those belong to the frontier model, not the gate)
- multi-installation / multi-tenant GitHub App support (the engine uses the
  configured single installation, like the rest of the app)
