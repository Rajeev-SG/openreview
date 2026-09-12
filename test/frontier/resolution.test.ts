import { describe, expect, test } from "bun:test";

import { handleFrontierEvent } from "@/lib/frontier/engine";
import {
  buildResolutionReport,
  parseChangedPaths,
  renderResolutionMarkdown,
} from "@/lib/frontier/resolution";
import { NEW_CYCLE_LABEL } from "@/lib/frontier/types";
import type { FrontierReview } from "@/lib/frontier/types";

import {
  createHarness,
  finding,
  labelEvent,
  pullRequestEvent,
} from "./harness";

const diffWith = (...paths: string[]): string =>
  paths
    .map((path) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`].join(
        "\n"
      )
    )
    .join("\n");

const changesRequired = (findings = [finding()]): FrontierReview => ({
  findings,
  summary: "One material problem.",
  verdict: "changes_required",
});

const pushRepair = (
  harness: ReturnType<typeof createHarness>,
  headSha: string
) => {
  harness.fakeGitHub.state.pr = {
    ...harness.fakeGitHub.state.pr,
    headSha,
  };
  return handleFrontierEvent(
    harness.deps,
    pullRequestEvent({ action: "synchronize", headSha })
  );
};

describe("parseChangedPaths", () => {
  test("extracts post-image paths from a unified diff", () => {
    expect(parseChangedPaths(diffWith("lib/a.ts", "test/a.test.ts"))).toEqual([
      "lib/a.ts",
      "test/a.test.ts",
    ]);
  });

  test("ignores deletions and non-path lines", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    expect(parseChangedPaths(diff)).toEqual([]);
  });

  test("strips a tab-separated timestamp and surrounding quotes", () => {
    expect(parseChangedPaths('+++ "b/a file.ts"\t2026-01-01')).toEqual([
      "a file.ts",
    ]);
  });
});

describe("buildResolutionReport", () => {
  const base = { requiredCiGreen: true };

  test("addresses a finding whose file changed while CI is green", () => {
    const report = buildResolutionReport({
      ...base,
      changedPaths: ["lib/a.ts"],
      findings: [finding({ id: "F1", path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(true);
    expect(report.entries[0].status).toBe("addressed");
  });

  test("leaves a finding unresolved when its file did not change", () => {
    const report = buildResolutionReport({
      ...base,
      changedPaths: ["lib/a.ts"],
      findings: [finding({ id: "F1", path: "lib/b.ts" })],
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved).toHaveLength(1);
  });

  test("leaves a finding unresolved when it names no file", () => {
    const report = buildResolutionReport({
      ...base,
      changedPaths: ["lib/a.ts"],
      findings: [finding({ id: "F1", path: undefined })],
    });
    expect(report.resolved).toBe(false);
  });

  test("leaves a finding unresolved when required CI is red", () => {
    const report = buildResolutionReport({
      changedPaths: ["lib/a.ts"],
      findings: [finding({ id: "F1", path: "lib/a.ts" })],
      requiredCiGreen: false,
    });
    expect(report.resolved).toBe(false);
  });

  test("an empty finding list never counts as resolved", () => {
    const report = buildResolutionReport({
      ...base,
      changedPaths: ["lib/a.ts"],
      findings: [],
    });
    expect(report.resolved).toBe(false);
  });

  test("renders every finding as a row", () => {
    const report = buildResolutionReport({
      ...base,
      changedPaths: ["lib/a.ts"],
      findings: [
        finding({ id: "F1", path: "lib/a.ts" }),
        finding({ id: "F2", path: "lib/b.ts" }),
      ],
    });
    const markdown = renderResolutionMarkdown(report);
    expect(markdown).toContain("| F1 |");
    expect(markdown).toContain("| F2 |");
    expect(markdown).toContain("**unresolved**");
  });
});

describe("resolution pass after a BLOCK", () => {
  test("a repair that changes the flagged file clears a required check for free", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: "lib/model.ts" })]),
      ],
    });

    // Review #2's finding names lib/model.ts, which the repair diff touches.
    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ready-final", { headSha: "head0002" })
    );
    expect(harness.model.calls).toHaveLength(2);

    const outcome = await pushRepair(harness, "head0003");

    expect(outcome.status).toBe("resolved");
    // no third paid call
    expect(harness.model.calls).toHaveLength(2);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
    expect(harness.fakeGitHub.comments.at(-1)).toContain("no frontier call");
  });

  test("a repair that leaves the flagged file untouched stays blocked", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: "lib/untouched.ts" })]),
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ready-final", { headSha: "head0002" })
    );

    const outcome = await pushRepair(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(outcome.calls).toBe(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  });

  test("a finding with no file path can never be auto-resolved", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: undefined })]),
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ready-final", { headSha: "head0002" })
    );

    const outcome = await pushRepair(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.model.calls).toHaveLength(2);
  });

  test("red required CI keeps the block even when the file changed", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: "lib/model.ts" })]),
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ready-final", { headSha: "head0002" })
    );

    harness.fakeGitHub.state.checks = [
      { conclusion: "failure", name: "ci", status: "completed" },
    ];

    const outcome = await pushRepair(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  });

  test("repeated events on the same SHA do not rewrite the check", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: "lib/model.ts" })]),
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ready-final", { headSha: "head0002" })
    );

    await pushRepair(harness, "head0003");
    const writes = harness.fakeGitHub.checkUpdates.length;

    // A check_run event for the SHA we just resolved must be a no-op, otherwise
    // the gate would write a check, observe its own event, and loop.
    await handleFrontierEvent(harness.deps, {
      action: "completed",
      deliveryId: "delivery-loop",
      headSha: "head0003",
      kind: "check_run",
      prNumber: 7,
      repo: "acme/widgets",
    });

    expect(harness.fakeGitHub.checkUpdates).toHaveLength(writes);
    expect(harness.model.calls).toHaveLength(2);
  });

  test("a passed cycle is never flipped to failure by a later push", async () => {
    const clean: FrontierReview = {
      findings: [],
      summary: "Looks good.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [clean] });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");

    await pushRepair(harness, "head0002");

    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
    expect(harness.model.calls).toHaveLength(1);
  });

  test("a new cycle label still restarts spend from a resolved PR", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: "lib/untouched.ts" })]),
      ],
    });

    const outcome = await handleFrontierEvent(
      harness.deps,
      labelEvent(NEW_CYCLE_LABEL, { headSha: "head0001" })
    );

    expect(outcome.calls).toBe(0);
  });
});
