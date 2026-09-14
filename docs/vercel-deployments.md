# Vercel deployments

How this project decides which Git pushes become Vercel deployments, and how to
get a preview when you actually want one.

## The policy

`main` deploys to production automatically, exactly as before. Nothing else
does. The rule lives in `vercel.json`:

```json
"git": {
  "deploymentEnabled": {
    "main": true,
    "manual-preview": true,
    "*": false,
    "**": false
  }
}
```

Vercel reads `vercel.json` from the **pushed commit**, not from `main`, so the
policy takes effect once it is on `main`. A branch whose tip predates the merge
(or was forked from an old `main`) still contains the old `vercel.json` and its
first push can still deploy once; re-create such a branch from the new `main`.

A branch matching any `true` rule deploys; a branch matching a `false` rule does
not; a branch matching no rule is enabled by default, which is why the `*` and
`**` catch-alls exist. Both are
listed because `*` does not cross `/`, so on its own it misses `gh-12/x` or
`fix/foo`.

| Branch           | Deploys?        | Why                      |
| ---------------- | --------------- | ------------------------ |
| `main`           | Yes, production | Explicitly enabled       |
| `manual-preview` | Yes, preview    | Exact-name escape hatch  |
| anything else    | No              | `*` and `**` are `false` |

`test/vercel-deployment-policy.test.ts` asserts this shape, so a future edit
cannot quietly turn previews back on or, worse, turn production off.

### Why an exact branch name for the escape hatch

Three facts were verified end to end on 2026-09-14 by pushing commits and
reading the deployment list back from the Vercel API:

- The `*`/`**` `false` catch-alls do suppress ordinary branches. A feature
  branch pushed as a unique commit (no prior deployment) with this policy
  produced **zero** deployments.
- An exact branch name listed as `true` deploys a preview even while the
  catch-alls also match it.
- When no catch-all is present, an unlisted branch deploys. This is why the
  catch-alls are required, and why removing them silently re-enables previews.

The escape hatch is an exact name rather than a `preview/**` glob because the
exact name is what was directly observed to work. Glob behaviour is **not**
claimed either way: several probe branches shared a single commit SHA, and
Vercel returns the existing deployment instead of creating a second one for a
SHA it has already built. An exact name avoids the question entirely.

## Getting a preview on demand

Two supported ways, both of which leave the automatic policy untouched.

**1. The `Preview on demand` workflow (no local setup).**
Run `.github/workflows/preview-on-demand.yml` from the Actions tab
(_Run workflow_). Optionally give it a ref (branch, tag or SHA). It
force-pushes that ref to the branch `manual-preview`, which the policy above
enables, and prints the preview URL in the run summary. Only that one preview
branch ever exists.

**2. The Vercel CLI, from your machine.**

```bash
vercel deploy            # preview of the working tree
vercel deploy --prod     # production
```

The CLI deployment path is not affected by `git.deploymentEnabled`; it builds
whatever you point it at. The project is linked already (`.vercel/`).

## What still works

- Production deploys on every merge to `main`.
- The `CI` workflow (`verify`: install, lint, typecheck, test, build) is
  unchanged and does not use a Vercel preview URL.
- No GitHub required status check depends on Vercel: branch protection requires
  `frontier-quality` and `verify`.
- OpenReview's own review webhook is unaffected: it reacts to GitHub events and
  clones the PR branch in a Vercel Sandbox, independent of Git deployments.

## Trade-off

A branch that is not `main` and not `manual-preview` gets no Vercel preview at
all, so there is no preview URL to click on an ordinary pull request. That is
the intent: the `verify` job already runs the full local check, and previews
were costing Hobby build/storage quota for no extra signal. Note this matters
more for this project than most, because a preview deployment carries the
production environment variables, so an automatic preview was a live instance
of the bot, not a harmless static copy.
