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

If the diff is more than 3× the diff cap, or more than 80 files change, the
packet is refused as `needs_manual_review` rather than sent unrepresentative.

## 5. Model call

One direct, non-streaming OpenRouter call:

```
model:      openai/gpt-6-astra
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

| `frontier-quality` conclusion | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| success                       | skipped (low value), or a review passed                    |
| action_required               | findings to fix, budget exhausted, or manual review needed |
| neutral                       | required CI failing; nothing was spent                     |
| failure                       | review #2 left blocking P0/P1/P2 findings                  |

## 7. State, idempotency and spend

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
FRONTIER_ENABLED=true
FRONTIER_MODEL=openai/gpt-6-astra
FRONTIER_REQUIRED_CHECKS=            (optional override, comma separated)
```

The budget guard runs **before** the request and fails closed: if the ledger
cannot be read, or a budget is 0, or the ceiling is reached, the review is
skipped with `0` calls and no fallback model.

Exact OpenRouter usage (`prompt_tokens`, `completion_tokens`, `cost`, model) is
recorded per review in the PR state and in daily/monthly spend ledgers.

## 8. Repo configuration

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

## 9. GitHub App permissions

The automatic path needs, in addition to the existing manual-path permissions:

- **Checks: Read & write** — to create and update `frontier-quality`
- **Pull requests: Read & write** — to read diffs and post findings
- Subscribed events: **Pull request**, **Check run** (plus the existing
  issue-comment and review-comment events)

## 10. Tests

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

## Not yet covered

- automatic PASS_WITH_BACKLOG issue creation, and P2/P3 backlog deduplication
- dashboards and ROI analytics beyond the recorded spend ledgers
- semantic packet retrieval, and holistic "primary user journey changed"
  judgements (those belong to the frontier model, not the gate)
- multi-installation / multi-tenant GitHub App support (the engine uses the
  configured single installation, like the rest of the app)
