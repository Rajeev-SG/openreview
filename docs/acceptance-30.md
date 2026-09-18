# Acceptance matrix — issue #30 (T01–T20)

Evidence captured 18 September 2026 against the **deployed** production app
(`app_id 3141537`), not a simulated smoke run. "Free" = zero model calls.
Where a row is a platform limitation rather than a pass, it says so.

| ID  | Result             | Evidence                                                                                                                                                                                                                                                    |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | **Pass**           | Docs-only PR #33 → `frontier-quality` "not required", 0 calls, durable state `skipped`/`reviewCount 0`. Mixed code+lockfile PRs are covered by existing packet tests (lockfile section dropped, code kept).                                                 |
| T02 | **Pass**           | Pending CI → `waiting_ci`, 0 calls; failing CI → `ci_failed`, 0 calls; unreadable → "needs CI configuration", 0 calls. Per-repo fallback via `required_checks:`; a context that is neither check run nor status → configuration error, not an endless wait. |
| T03 | **Pass**           | Issuer binding: a same-named check from another App does not satisfy a required context (adapter test, fails pre-fix). A pass on an earlier commit is "NOT REVIEWED AT THIS COMMIT" (guard).                                                                |
| T04 | **Pass**           | Guard denied a merge with outstanding findings: `merge-guard.sh 31` → `status: blocked`, exit 1, PR `mergeStateStatus: BLOCKED`. Same guard allowed it after resolution → exit 0. Unrelated shell commands unaffected.                                      |
| T05 | **Pass (partial)** | Guard absent → deny; unreadable JSON → deny; exit 3 → allow (documented as tooling error, cannot hide a finding). Browser merges remain outside any local hook — documented limitation.                                                                     |
| T06 | **Pass**           | A pass carrying P0–P2 findings reports `action_required`, not success (existing behaviour + tests).                                                                                                                                                         |
| T07 | **Pass**           | Changelog-only / lockfile-only / empty delta → 0 calls, 0 slots, explicit state; a later real fix gets the final review. Deployed: observed on PR #32.                                                                                                      |
| T08 | **Pass**           | Delivery dedup, per-PR lock, paid-call idempotency keyed on cycle+packet+sha; duplicate/stale events produce no second call.                                                                                                                                |
| T09 | **Pass**           | After a BLOCK, a meaningful fix + green CI resolves free, labelled "no re-review". Deployed on PRs #31 and #32.                                                                                                                                             |
| T10 | **Pass**           | Resolution requires the flagged file changed and CI green; a deletion is not a repair; a comment-only touch cannot satisfy the _repair-delta_ gate. Semantic re-review is not claimed.                                                                      |
| T11 | **Pass**           | A path that is not a repo file → `not_verifiable` with an owner-decision path (`frontier-ack-not-verifiable`); an untrustworthy listing keeps findings blocking.                                                                                            |
| T12 | **Pass**           | A failed final review re-arms `frontier-ready-final`, so the retry is one re-add rather than a silent no-op (fixed and tested; observed live).                                                                                                              |
| T13 | **Pass**           | Oversized material diff → early non-spending refusal; provider error → bounded failure with the label re-armed; no hidden code loss.                                                                                                                        |
| T14 | **Blocked**        | The rename itself needs the owner's sudo-mode MFA (see #30 comment). Everything a rename must preserve is proven intact today; identity is read from the App slug, so no code change is needed.                                                             |
| T15 | **Pass**           | Deployed canaries: real signed events on PRs #31/#32 produced check runs at the exact head, durable state, comments, and head-specific eligibility.                                                                                                         |
| T16 | **Pass (partial)** | Manual mention on PR #33 produced one substantive correct-PR review and did **not** double-trigger automatic spend (`skipped`, `reviewCount 0`). Unauthorized/forged triggers are rejected by signature verification (existing tests).                      |
| T17 | **Pass**           | Generated-data publishers are not force-reviewed; new code repos follow the documented policy (public repos gated server-side; private repos rely on the local guard, documented).                                                                          |
| T18 | **Pass**           | Rollback: `FRONTIER_ENABLED=false` disables spend without a deploy; code rollback re-aliases a previous deployment; Redis state survives. Mid-cycle restart does not duplicate paid calls (idempotency key).                                                |
| T19 | **Pass**           | Findings are treated as untrusted structured data: schema-validated, priorities/locations normalised, malformed output rejected rather than counted as a pass; no arbitrary command execution; secrets redacted.                                            |
| T20 | **Pass**           | PRs #31 and #32 went from open to merged with no human nudge: review, repair, free resolution, guard clear, merge, cleanup.                                                                                                                                 |

## Cost honesty

Four paid reviews total across two PRs (2 per cycle, the documented maximum).
The day's ledger (8 calls / $1.18) includes earlier unrelated activity. No
`frontier-new-cycle` was added; no check was weakened or skipped.
