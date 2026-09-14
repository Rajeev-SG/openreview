import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Guard the git deployment policy in vercel.json.
//
// Vercel was building a preview for every feature-branch push and every PR,
// which costs Hobby build/storage quota and buys nothing: CI already runs
// install, lint, typecheck, tests and build on every PR. The policy below keeps
// `main` deploying to production automatically and suppresses automatic
// previews for everything else. `vercel deploy` and the `manual-preview`
// branch remain as the on-demand escape hatches.
//
// These assertions exist so a future edit cannot quietly re-enable previews or,
// worse, disable production deployments from `main`.
type DeploymentPolicy = Record<string, boolean>;

const readPolicy = (): DeploymentPolicy => {
  const raw = readFileSync("vercel.json", "utf8");
  const config = JSON.parse(raw) as {
    git?: { deploymentEnabled?: DeploymentPolicy | boolean };
  };
  const enabled = config.git?.deploymentEnabled;
  if (enabled === undefined || typeof enabled === "boolean") {
    throw new Error(
      "vercel.json git.deploymentEnabled must be an object of branch -> boolean"
    );
  }
  return enabled;
};

describe("vercel.json git deployment policy", () => {
  test("keeps automatic production deployments for main", () => {
    expect(readPolicy().main).toBe(true);
  });

  test("suppresses automatic previews for every other branch", () => {
    const policy = readPolicy();
    // Both patterns are present so a slash-delimited branch (gh-12/x,
    // fix/foo) is caught, not only a top-level name.
    expect(policy["*"]).toBe(false);
    expect(policy["**"]).toBe(false);
  });

  test("keeps the on-demand preview branch enabled by exact name", () => {
    // `manual-preview` is what the "Preview on demand" workflow pushes to.
    // It must be an exact name: on this project Vercel only honours literal
    // branch names in git.deploymentEnabled, so a `preview/**` glob does not
    // produce a deployment (verified 2026-09-14). See docs/vercel-deployments.md.
    expect(readPolicy()["manual-preview"]).toBe(true);
  });
});
