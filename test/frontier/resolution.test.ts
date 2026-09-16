import { describe, expect, test } from "bun:test";

import { handleFrontierEvent } from "@/lib/frontier/engine";
import {
  buildResolutionReport,
  matchPath,
  parseChangedPaths,
  parseFileChanges,
  renderResolutionMarkdown,
} from "@/lib/frontier/resolution";
import { loadPrState, savePrState } from "@/lib/frontier/store";
import type { FrontierPrState, FrontierReview } from "@/lib/frontier/types";

import {
  createHarness,
  failFirstAttempt,
  finding,
  labelEvent,
  pullRequestEvent,
} from "./harness";

const diffWith = (...paths: string[]): string =>
  paths
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,3 +1,3 @@",
        "-const a = 1;",
        "+const a = 2;",
      ].join("\n")
    )
    .join("\n");

const changesRequired = (findings = [finding()]): FrontierReview => ({
  findings,
  summary: "One material problem.",
  verdict: "changes_required",
});

const push = (
  harness: ReturnType<typeof createHarness>,
  headSha: string,
  kind: "check_run" | "pull_request" = "pull_request"
) => {
  harness.fakeGitHub.state.pr = {
    ...harness.fakeGitHub.state.pr,
    headSha,
  };
  return handleFrontierEvent(harness.deps, {
    action: kind === "check_run" ? "completed" : "synchronize",
    deliveryId: `delivery-${headSha}-${kind}-${Math.random()}`,
    headSha,
    kind,
    prNumber: 7,
    repo: "acme/widgets",
  });
};

/** Drives a PR to review #2 and a BLOCK. */
const driveToBlock = async (
  harness: ReturnType<typeof createHarness>,
  findings = [finding({ id: "F2", line: 2, path: "lib/model.ts" })]
): Promise<void> => {
  await handleFrontierEvent(harness.deps, pullRequestEvent());
  await push(harness, "head0002");
  await handleFrontierEvent(
    harness.deps,
    labelEvent("frontier-ready-final", { headSha: "head0002" })
  );
  expect(findings).toBeDefined();
  expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  expect(harness.model.calls).toHaveLength(2);
};

describe("parseFileChanges", () => {
  test("records the post-image path and hunk range", () => {
    const [change] = parseFileChanges(diffWith("lib/a.ts"));
    expect(change.path).toBe("lib/a.ts");
    expect(change.deleted).toBe(false);
    expect(change.hunks).toEqual([{ end: 3, start: 1 }]);
  });

  test("marks a deleted file, keeping the pre-image path", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-x",
    ].join("\n");
    const [change] = parseFileChanges(diff);
    expect(change.path).toBe("gone.ts");
    expect(change.deleted).toBe(true);
  });

  test("handles an added file with a /dev/null pre-image", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+x",
    ].join("\n");
    const [change] = parseFileChanges(diff);
    expect(change.path).toBe("new.ts");
    expect(change.deleted).toBe(false);
    expect(change.hunks).toEqual([{ end: 2, start: 1 }]);
  });

  test("strips a tab-separated timestamp and surrounding quotes", () => {
    const [change] = parseFileChanges('+++ "b/a file.ts"\t2026-01-01');
    expect(change.path).toBe("a file.ts");
  });

  test("a deletion-only hunk has a single-line range", () => {
    const [change] = parseFileChanges(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -4 +4 @@",
      ].join("\n")
    );
    expect(change.hunks).toEqual([{ end: 4, start: 4 }]);
  });
});

describe("parseChangedPaths", () => {
  test("lists post-image paths and omits deletions", () => {
    const deleted = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
    ].join("\n");
    expect(parseChangedPaths(`${diffWith("lib/a.ts")}\n${deleted}`)).toEqual([
      "lib/a.ts",
    ]);
  });
});

describe("matchPath", () => {
  const changes = parseFileChanges(diffWith("src/lib/model.ts"));

  test("matches exactly", () => {
    expect(matchPath("src/lib/model.ts", changes)?.mode).toBe("exact");
  });

  test("tolerates a leading ./", () => {
    expect(matchPath("./src/lib/model.ts", changes)?.mode).toBe("normalised");
  });

  test("falls back to an unambiguous basename", () => {
    expect(matchPath("lib/model.ts", changes)?.mode).toBe("basename");
  });

  test("returns null when nothing matches", () => {
    expect(matchPath("lib/other.ts", changes)).toBeNull();
  });

  test("refuses an ambiguous basename", () => {
    const many = parseFileChanges(
      `${diffWith("a/model.ts")}\n${diffWith("b/model.ts")}`
    );
    expect(matchPath("model.ts", many)).toBeNull();
  });
});

describe("buildResolutionReport", () => {
  const changes = parseFileChanges(diffWith("lib/a.ts"));
  const base = { changes, requiredCiGreen: true };

  test("addresses a finding whose file changed at the flagged line", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", line: 2, path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(true);
    expect(report.entries[0].status).toBe("addressed");
  });

  test("resolves a file-level finding whose line is 0", () => {
    // No hunk contains line 0, so enforcing the line check would leave the
    // finding permanently unresolvable and block the cycle forever.
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F4", line: 0, path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(true);
    expect(report.entries[0].status).toBe("addressed");
  });

  test("leaves a finding unresolved when the change misses the flagged line", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", line: 900, path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved[0].evidence).toContain("not at line 900");
  });

  test("resolves a finding whose reported line is past the end of the file", () => {
    // A line beyond the file's length can never be reached by a hunk, so
    // enforcing it would pin the cycle blocked forever - the same class of
    // defect as a non-positive line.
    const report = buildResolutionReport({
      ...base,
      fileLineCounts: { "lib/a.ts": 40 },
      findings: [finding({ id: "delta-1", line: 482, path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(true);
    expect(report.entries[0].status).toBe("addressed");
    expect(report.entries[0].evidence).toContain("past the file's 40 lines");
  });

  test("still requires the line when it exists in the file", () => {
    const report = buildResolutionReport({
      ...base,
      fileLineCounts: { "lib/a.ts": 900 },
      findings: [finding({ id: "F1", line: 500, path: "lib/a.ts" })],
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved[0].evidence).toContain("not at line 500");
  });

  test("leaves a finding unresolved when its file did not change", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", path: "lib/b.ts" })],
    });
    expect(report.resolved).toBe(false);
  });

  test("leaves a finding unresolved when it names no file", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", path: undefined })],
    });
    expect(report.resolved).toBe(false);
  });

  test("deleting the flagged file is not a repair", () => {
    const deletion = parseFileChanges(
      [
        "diff --git a/lib/a.ts b/lib/a.ts",
        "--- a/lib/a.ts",
        "+++ /dev/null",
      ].join("\n")
    );
    const report = buildResolutionReport({
      changes: deletion,
      findings: [finding({ id: "F1", path: "lib/a.ts" })],
      requiredCiGreen: true,
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved[0].evidence).toContain("deleted");
  });

  test("leaves a finding unresolved when required CI is red", () => {
    const report = buildResolutionReport({
      changes,
      findings: [finding({ id: "F1", line: 2, path: "lib/a.ts" })],
      requiredCiGreen: false,
    });
    expect(report.resolved).toBe(false);
  });

  test("an empty finding list never counts as resolved", () => {
    expect(buildResolutionReport({ ...base, findings: [] }).resolved).toBe(
      false
    );
  });

  test("renders every finding as a row", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [
        finding({ id: "F1", line: 2, path: "lib/a.ts" }),
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
  test("a repair at the flagged line clears the check for free", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", line: 2, path: "lib/model.ts" })]),
      ],
    });
    await driveToBlock(harness);

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("resolved");
    // no third paid call
    expect(harness.model.calls).toHaveLength(2);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
  });

  test("a repair that misses the flagged line stays blocked", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([
          finding({ id: "F2", line: 900, path: "lib/model.ts" }),
        ]),
      ],
    });
    await driveToBlock(harness, [
      finding({ id: "F2", line: 900, path: "lib/model.ts" }),
    ]);

    const outcome = await push(harness, "head0003");

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
    await driveToBlock(harness, [finding({ id: "F2", path: undefined })]);

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.model.calls).toHaveLength(2);
  });

  test("red required CI keeps the block even when the file changed", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", line: 2, path: "lib/model.ts" })]),
      ],
    });
    await driveToBlock(harness);

    harness.fakeGitHub.state.checks = [
      { conclusion: "failure", name: "ci", status: "completed" },
    ];

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  });

  test("repeated check_run events on a resolved SHA write nothing more", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", line: 2, path: "lib/model.ts" })]),
      ],
    });
    await driveToBlock(harness);

    await push(harness, "head0003");
    const writes = harness.fakeGitHub.checkUpdates.length;
    const successes = harness.fakeGitHub.comments.filter((body) =>
      body.includes("blocking findings resolved")
    ).length;

    await push(harness, "head0003", "check_run");
    await push(harness, "head0003", "check_run");

    expect(harness.fakeGitHub.checkUpdates).toHaveLength(writes);
    expect(
      harness.fakeGitHub.comments.filter((body) =>
        body.includes("blocking findings resolved")
      )
    ).toHaveLength(successes);
    expect(harness.model.calls).toHaveLength(2);
  });

  test("repeated check_run events on a blocked SHA write nothing more", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", path: undefined })]),
      ],
    });
    await driveToBlock(harness, [finding({ id: "F2", path: undefined })]);

    await push(harness, "head0003");
    const writes = harness.fakeGitHub.checkUpdates.length;

    await push(harness, "head0003", "check_run");

    expect(harness.fakeGitHub.checkUpdates).toHaveLength(writes);
  });

  test("a failed check write does not leave durable state claiming success", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", line: 2, path: "lib/model.ts" })]),
      ],
    });
    await driveToBlock(harness);

    const original = harness.fakeGitHub.github.setFrontierCheck;
    const failOnce = failFirstAttempt(original);

    harness.fakeGitHub.github.setFrontierCheck = failOnce.fn;

    await expect(push(harness, "head0003")).rejects.toThrow(
      "transient failure"
    );

    const stored = await loadPrState(harness.kv, "acme/widgets", 7);

    expect(stored?.resolutionResolved).toBeUndefined();
    expect(stored?.lifecycle).toBe("blocked");

    // A retry converges on the same verdict.
    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("resolved");
    expect(harness.model.calls).toHaveLength(2);
  });

  test("a passed cycle is never flipped to failure by a later push", async () => {
    const harness = createHarness({
      reviews: [{ findings: [], summary: "Looks good.", verdict: "pass" }],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");

    await push(harness, "head0002");

    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("non-file finding paths", () => {
  const changes = parseFileChanges(diffWith("lib/a.ts"));
  const base = { changes, requiredCiGreen: true };

  test("reports a finding whose path is not a repository file as not verifiable", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", path: "PR description / CI gate" })],
      nonFileFindingPaths: new Set(["PR description / CI gate"]),
    });
    // Not resolved: an owner decision (frontier-ack-not-verifiable) is
    // required before the check may clear.
    expect(report.resolved).toBe(false);
    expect(report.unresolved).toHaveLength(0);
    expect(report.notVerifiable).toHaveLength(1);
    expect(report.entries[0].status).toBe("not_verifiable");
    expect(report.entries[0].evidence).toContain("not a repository file");
    expect(renderResolutionMarkdown(report)).toContain(
      "not deterministically verifiable"
    );
  });

  test("a real file missing from the repair diff stays unresolved", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [finding({ id: "F1", path: "lib/b.ts" })],
      nonFileFindingPaths: new Set(["lib/c.ts"]),
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved.map((entry) => entry.id)).toEqual(["F1"]);
  });

  test("a not-verifiable finding does not mask an unresolved one", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [
        finding({ id: "F1", path: "PR description / CI gate" }),
        finding({ id: "F2", path: "lib/b.ts" }),
      ],
      nonFileFindingPaths: new Set(["PR description / CI gate"]),
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved.map((entry) => entry.id)).toEqual(["F2"]);
  });

  test("a not-verifiable finding keeps the cycle from a deterministic pass even alongside an addressed one", () => {
    const report = buildResolutionReport({
      ...base,
      findings: [
        finding({ id: "F1", path: "PR description / CI gate" }),
        finding({ id: "F2", line: 2, path: "lib/a.ts" }),
      ],
      nonFileFindingPaths: new Set(["PR description / CI gate"]),
    });
    expect(report.resolved).toBe(false);
    expect(report.unresolved).toHaveLength(0);
    expect(report.notVerifiable).toHaveLength(1);
  });
});

describe("engine resolution with a non-file finding path", () => {
  const nonFileFinding = [
    finding({ id: "F1", path: "PR description / CI gate" }),
  ];

  test("a repair push after a transient lifecycle overwrite still gets the resolution pass", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2", line: 2, path: "lib/model.ts" })]),
      ],
    });
    await driveToBlock(harness);

    // A later event (e.g. the cycle parking while required CI runs) overwrote
    // the blocked lifecycle. The verdict must survive it: a repair push must
    // reach the deterministic resolution pass, not the budget-spent dead end.
    const stored = (await loadPrState(
      harness.kv,
      "acme/widgets",
      7
    )) as FrontierPrState;
    const waiting = { ...stored, lifecycle: "waiting_ci" as const };
    await savePrState(harness.kv, waiting, new Date());

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("resolved");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
    expect(harness.model.calls).toHaveLength(2);
  });

  test("a non-file finding parks the check for an owner decision, then the ack clears it", async () => {
    const harness = createHarness({
      repo: { repoFiles: [] },
      reviews: [changesRequired(), changesRequired(nonFileFinding)],
    });
    await driveToBlock(harness, nonFileFinding);

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("needs_manual_review");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe(
      "action_required"
    );
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.summary).toContain(
      "Owner decision required"
    );

    const acked = await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-ack-not-verifiable", { headSha: "head0003" })
    );

    expect(acked.status).toBe("resolved");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.summary).toContain(
      "Owner acknowledged"
    );
    expect(harness.fakeGitHub.comments.at(-1)).toContain(
      "acknowledged by owner"
    );
    expect(harness.model.calls).toHaveLength(2);
  });

  test("an untrustworthy repo listing never waives a finding (null is not proof of non-existence)", async () => {
    const harness = createHarness({
      // repoFiles left unset: listRepoFiles reports "unknown".
      reviews: [changesRequired(), changesRequired(nonFileFinding)],
    });
    await driveToBlock(harness, nonFileFinding);

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  });

  test("a misnamed reference to a real, untouched repository file stays blocked", async () => {
    // matchPath's basename tolerance must extend to the non-file classifier:
    // `src/lib/other.ts` is not a path in this repo, but `lib/other.ts` is,
    // and that file is not part of the repair diff.
    const harness = createHarness({
      repo: { repoFiles: ["lib/other.ts", "README.md"] },
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F1", path: "src/lib/other.ts" })]),
      ],
    });
    await driveToBlock(harness, [
      finding({ id: "F1", path: "src/lib/other.ts" }),
    ]);

    const outcome = await push(harness, "head0003");

    expect(outcome.status).toBe("blocked");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");
  });
});
