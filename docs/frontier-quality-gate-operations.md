# Frontier quality gate — deployment and operations

The design and behaviour live in [`frontier-quality-gate.md`](./frontier-quality-gate.md).
This file is the operator's guide: what is deployed, how to set it up from
scratch, and the traps that cost real time.

## Deployed state (verified 2026-09-12)

| Thing                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| Vercel project       | `rajeevgills-projects/openreview-openrouter` (`prj_TVFq09iFUYBIsQeK0CXXF57LYGZJ`) |
| Production URL       | https://openreview-openrouter.vercel.app                                          |
| Production branch    | `openrouter-vercel`                                                               |
| Durable state        | Upstash for Redis, resource `openreview-frontier-state`, exposed as `REDIS_URL`   |
| GitHub App           | `openreview-property-search` (App ID `3141537`)                                   |
| Installation         | `117789216`, fixed installation (not multi-tenant)                                |
| Installed on         | `Rajeev-SG/property-search` — `repository_selection: selected`                    |
| Judge model          | `z-ai/glm-5.3`                                                                    |
| Measured review cost | ~$0.015 (6.9k in / 1.4k out)                                                      |

## Setup, in order

1. **Deploy the app** and set the environment variables (below).
   1b. **Make the repository's own CI check required too**, alongside
   `frontier-quality`, so the gate has something meaningful to wait for. Where
   `frontier-quality` is the only required check, the gate reviews immediately.
2. **Create the GitHub App** with a webhook pointing at
   `https://<deployment>/api/webhooks`, and set its secret to
   `GITHUB_APP_WEBHOOK_SECRET`.
3. **Grant permissions and events** (see _GitHub App settings_).
4. **Accept the permission change on the installation** — this is a separate
   step and easy to miss; see the trap below.
5. **Install the App on the repositories** you want gated.
6. **Provision durable state** (`REDIS_URL`). Without it the gate fails closed.
7. **Make `frontier-quality` a required check** on the target branch, or set
   `FRONTIER_REQUIRED_CHECKS`. Otherwise CI gating is a no-op: the gate waits
   for required checks, and a repository with none configured has nothing to
   wait for.
8. **Verify** with the recipe below.

## Environment variables

Set on the Vercel project (all optional except the four required for the App and
the model provider):

| Variable                                                                                             | Default        | Purpose                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`                                                                                 | —              | **Required.** Model provider.                                                                                            |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | —              | **Required.** GitHub App credentials (`\n`-escaped key).                                                                 |
| `REDIS_URL`                                                                                          | —              | **Required for the gate.** Durable state; without it the gate fails closed, spending nothing.                            |
| `FRONTIER_ENABLED`                                                                                   | `true`         | Set `false` to disable the automatic path.                                                                               |
| `FRONTIER_MODEL`                                                                                     | `z-ai/glm-5.3` | Judge model. Must support structured outputs + reasoning.                                                                |
| `FRONTIER_DAILY_BUDGET_USD`                                                                          | `5`            | Daily ceiling.                                                                                                           |
| `FRONTIER_MONTHLY_BUDGET_USD`                                                                        | `50`           | Monthly ceiling.                                                                                                         |
| `FRONTIER_MAX_CALL_USD`                                                                              | `0.5`          | Floor for the per-review reservation. Must be `> 0`.                                                                     |
| `FRONTIER_INPUT_USD_PER_MTOK`                                                                        | `1.4`          | Input price, used to derive the reservation.                                                                             |
| `FRONTIER_OUTPUT_USD_PER_MTOK`                                                                       | `4.4`          | Output price, used to derive the reservation.                                                                            |
| `FRONTIER_REQUIRED_CHECKS`                                                                           | —              | Comma-separated required checks, overriding branch protection.                                                           |
| `FRONTIER_CI_WAIT_TIMEOUT_MS`                                                                        | `1800000`      | How long to wait for required CI before failing closed. A required check that never reports must not block a PR forever. |
| `FRONTIER_MAX_REVIEWS_PER_CYCLE`                                                                     | `2`            | Clamped to 2; cannot be raised.                                                                                          |
| `FRONTIER_MAX_PACKET_CHARS`                                                                          | `50000`        | Packet cap.                                                                                                              |
| `FRONTIER_MAX_DIFF_CHARS`                                                                            | `35000`        | Diff cap.                                                                                                                |
| `FRONTIER_MAX_CONTEXT_FILES`                                                                         | `6`            | Local context files.                                                                                                     |
| `FRONTIER_MAX_CONTEXT_PER_FILE_CHARS`                                                                | `4000`         | Per-file context cap.                                                                                                    |
| `FRONTIER_MAX_PR_BODY_CHARS`                                                                         | `4000`         | PR body cap.                                                                                                             |
| `FRONTIER_MAX_LINKED_ISSUE_CHARS`                                                                    | `5000`         | Linked issue cap.                                                                                                        |
| `FRONTIER_MAX_OUTPUT_TOKENS`                                                                         | `3000`         | Model output cap.                                                                                                        |

## GitHub App settings

Repository permissions: **Checks: Read & write** (to create `frontier-quality`),
**Administration: Read-only** (to read the branch's required checks), plus
`contents`, `issues` and `pull_requests` (write) for the existing paths.

Subscribe to events: `pull_request`, `check_run`, `issue_comment`,
`pull_request_review_comment`.

### Trap: without `administration`, the gate silently ignores required CI

Reading a branch's required checks requires repository **Administration** access.
An App without it gets `403 Resource not accessible by integration`, and if that
is treated as "no required checks" the gate reviews immediately instead of
waiting for CI — the wait-for-required-CI guarantee silently stops working.

The gate **fails closed**: an unreadable required-check list is reported as
_unknown_, not as "no required checks". It writes an `action_required` check
explaining that CI could not be determined, and spends **$0** rather than
reviewing without being able to honour the wait-for-CI guarantee.

Either grant **Administration: Read-only** (and accept the installation update),
or set `FRONTIER_REQUIRED_CHECKS` — which takes precedence over branch
protection when set. Verify with an installation token:

```bash
# should be 200, not 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <installation-token>" \
  https://api.github.com/repos/<owner>/<repo>/branches/main/protection/required_status_checks
```

### Precedence of FRONTIER_REQUIRED_CHECKS

When set, `FRONTIER_REQUIRED_CHECKS` **replaces** branch protection entirely for
that deployment (branch protection is not consulted), and the gate's own check
is stripped out of it. Use it for repositories the App cannot read, or to pin an
explicit list. A name listed there that never reports will hang the gate at
"waiting for required CI" indefinitely, so list only checks that actually run.

### Trap: the gate must never be its own required check

`frontier-quality` is normally a required branch check, and the gate reads
required checks to decide whether it may spend. Left in that list, it would wait
for the check it is about to create and deadlock — every PR stuck at
"Expected — waiting for status to be reported". It is always excluded.

### Trap: the permission change needs a second approval

Adding **Checks** to the App does **not** change the installation. GitHub raises
a permission-review request, and until it is accepted the installation keeps its
old permissions — the App gets `403` when creating a check run, and the failure
is easy to misread as a code bug.

Accept it at
`https://github.com/settings/installations/<installation_id>/permissions/update`
(or _Review request_ on the installation page). Verify with the API:

```bash
# app-level: should list check_run and pull_request
gh api /app --jq '.events'
# installation-level: should show checks: write
gh api /app/installations/<installation_id> --jq '.permissions'
```

`GET /app` does **not** return the webhook in its `hook` key. To confirm the
webhook is configured, use `GET /app/hook/config` (URL + whether a secret is
set) or `GET /app/hook/deliveries` instead of concluding "no webhook".

## Invoking it

- **Automatic:** open or update a PR. No mention needed.
- **Manual (`@openreview` agent):** mention the App's slug — the handle is the
  App name, **not** the repository name. On this deployment that is
  `@openreview-property-search`. A bare `@openreview` matches the adapter's
  configured `userName`, finds no handler, and silently does nothing.

## Traps

### One workflow directive kind per module

The Workflow Dev Kit discovers directives per file. A module containing both
`"use step"` and `"use workflow"` functions registers only one of them, and
`start()` then throws at runtime:

```
Error [WorkflowRuntimeError]: 'start' received an invalid workflow function.
```

Keep workflows in `workflow/*.ts` and steps in `workflow/steps/*.ts`. `bun run
build` prints the counts — `Created manifest with N steps, M workflows` — so a
workflow that does not increment `M` is not registered.

### Pin a supported Workflow SDK release

An outdated beta fails **every** delivery at runtime with HTTP `426`:

```
Error [WorkflowAPIError]: This Workflow 4.x beta release is no longer
supported for starting new runs.
```

Keep `workflow` and `@workflow/ai` on a compatible pair (`@workflow/ai@4.2.1`
requires `workflow: ^4.8.5`). This affects the manual `@openreview` path too,
because it also calls `start()`.

### `vercel env pull` blanks sensitive values

Sensitive production variables are pulled as empty strings, so a local
`next build` fails env validation. Copy the real values into `.env.local`
manually, or build with `SKIP_ENV_VALIDATION=1`.

### Replacing a secret

`vercel env add <NAME> production --force` does not reliably overwrite. Remove
then add, and confirm by pulling again (interpreting the empty value above):

```bash
vercel env rm <NAME> production --yes
vercel env add <NAME> production --value "$VALUE"
```

Rotating `GITHUB_APP_WEBHOOK_SECRET` requires updating it in **both** places —
the App's webhook settings and Vercel — or GitHub's signature check and the
deployed app's verification disagree and every delivery `401`s.

### Deploying

`vercel --prod --yes` from the repo root. Verify the alias actually moved
(`Aliased: https://…`) before trusting the deployment.

## Verification

```bash
# 1. liveness
curl -s -o /dev/null -w '%{http_code}\n' https://openreview-openrouter.vercel.app/

# 2. a signed delivery reaches the app and is accepted (200, queued)
#    see scripts/frontier-smoke.ts for the local end-to-end run

# 3. the gate ran
vercel logs --environment production --no-follow --no-branch --limit 20 -x \
  | grep '\[frontier\]'

# 4. a check exists on the PR
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | select(.name=="frontier-quality") | "\(.status) \(.conclusion)"'
```

Expected log sequence for a reviewed PR:

```
[frontier] frontier.gate    { mode: 'review', score: 5 }
[frontier] frontier.spend   { model: 'z-ai/glm-5.3', ..., costUsd: 0.0156 }
[frontier] frontier.outcome { calls: 1, lifecycle: 'waiting_final_signal' }
```

`frontier.no_durable_state` means `REDIS_URL` is missing — by design, nothing is
spent. `frontier.duplicate_delivery` on its own is normal; it appears when
GitHub redelivers an event.

## Cost

One review is roughly **$0.015–0.025** on `z-ai/glm-5.3` (~7k input, ~1.4k
output tokens), against ~$0.16 on the previous `openai/gpt-6-astra` judge.
Skipped PRs cost $0. The derived reservation is ~$0.30 at the default caps, so
`FRONTIER_MAX_CALL_USD` (0.5) governs; spend is reconciled to the real cost after
each call.
