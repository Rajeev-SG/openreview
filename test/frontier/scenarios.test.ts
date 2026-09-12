import { describe, expect, test } from "bun:test";

import { dayKey, readSpend } from "@/lib/frontier/budget";
import { handleFrontierEvent } from "@/lib/frontier/engine";
import type { FrontierOutcome } from "@/lib/frontier/engine";
import { createMemoryKv } from "@/lib/frontier/store";
import { FINAL_SIGNAL_LABEL, NEW_CYCLE_LABEL } from "@/lib/frontier/types";
import type { FrontierReview } from "@/lib/frontier/types";

import {
  createHarness,
  DEFAULT_USAGE,
  finding,
  HARNESS_NOW,
  labelEvent,
  pullRequestEvent,
  reviewPrompt,
} from "./harness";

const clean: FrontierReview = {
  findings: [],
  summary: "Looks good.",
  verdict: "pass",
};

const changesRequired = (findings = [finding()]): FrontierReview => ({
  findings,
  summary: "One material problem.",
  verdict: "changes_required",
});

const pushRepair = (
  harness: ReturnType<typeof createHarness>,
  headSha: string,
  action = "synchronize"
): Promise<FrontierOutcome> => {
  harness.fakeGitHub.state.pr = {
    ...harness.fakeGitHub.state.pr,
    headSha,
  };
  return handleFrontierEvent(
    harness.deps,
    pullRequestEvent({ action, headSha })
  );
};

describe("scenario A — trivial PR", () => {
  test("README-only change is skipped with zero frontier calls", async () => {
    const harness = createHarness({
      repo: {
        diff: "+docs",
        files: [
          { additions: 3, deletions: 0, path: "README.md", status: "modified" },
        ],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("skipped");
    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
  });
});

describe("scenario B — meaningful clean PR", () => {
  test("required CI green then one clean review", async () => {
    const harness = createHarness({ reviews: [clean] });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(outcome.calls).toBe(1);
    expect(harness.model.calls).toHaveLength(1);
    expect(harness.model.calls[0]?.maxTokens).toBe(3000);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
  });
});

describe("scenario C — seeded defect, repair, delta review", () => {
  test("review #1 fix push is free and review #2 is delta-only", async () => {
    const harness = createHarness({ reviews: [changesRequired(), clean] });

    const first = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(first.status).toBe("waiting_final_signal");
    expect(first.calls).toBe(1);

    await pushRepair(harness, "head0002");
    await pushRepair(harness, "head0003");
    expect(harness.model.calls).toHaveLength(1);

    const final = await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0003" })
    );

    expect(final.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(2);

    const delta = reviewPrompt(harness.model, 1);
    expect(delta).toContain("Delta review (#2)");
    expect(delta).toContain("head0001");
    expect(delta).not.toContain("## Changed files");

    const evidence = await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0003" })
    );
    expect(evidence.calls).toBe(0);
  });
});

describe("scenario D — ten repair pushes", () => {
  test("ten synchronize events after review #1 cost nothing", async () => {
    const harness = createHarness({ reviews: [changesRequired(), clean] });
    await handleFrontierEvent(harness.deps, pullRequestEvent());

    for (let index = 1; index <= 10; index += 1) {
      await pushRepair(harness, `head${String(index).padStart(4, "0")}`);
    }

    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("scenario E — final repair still wrong", () => {
  test("review #2 blocks, further pushes never call the model", async () => {
    const harness = createHarness({
      reviews: [changesRequired(), changesRequired([finding({ id: "F2" })])],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");

    const final = await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );

    expect(final.status).toBe("blocked");
    expect(harness.model.calls).toHaveLength(2);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("failure");

    await pushRepair(harness, "head0003");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0003" })
    );

    expect(harness.model.calls).toHaveLength(2);
  });
});

describe("scenario F — explicit new cycle", () => {
  test("only frontier-new-cycle can restart spend, and it resets the cycle", async () => {
    const harness = createHarness({
      reviews: [
        changesRequired(),
        changesRequired([finding({ id: "F2" })]),
        clean,
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );

    // An ordinary push must not start a new cycle.
    const pushed = await pushRepair(harness, "head0003");
    expect(pushed.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(2);

    const restarted = await handleFrontierEvent(
      harness.deps,
      labelEvent(NEW_CYCLE_LABEL, { headSha: "head0003" })
    );

    expect(restarted.cycleId).toBe(2);
    expect(restarted.calls).toBe(1);
    expect(harness.model.calls).toHaveLength(3);
    expect(restarted.status).toBe("passed");
  });
});

describe("scenario G — duplicate webhook", () => {
  test("a replayed delivery is deduplicated", async () => {
    const harness = createHarness({ reviews: [clean] });
    const event = pullRequestEvent({ deliveryId: "delivery-fixed-1" });

    const first = await handleFrontierEvent(harness.deps, event);
    const second = await handleFrontierEvent(harness.deps, event);

    expect(first.calls).toBe(1);
    expect(second.status).toBe("duplicate");
    expect(second.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("scenario H — required CI failure", () => {
  test("no frontier call when required CI fails", async () => {
    const harness = createHarness({
      repo: {
        checks: [{ conclusion: "failure", name: "ci", status: "completed" }],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("ci_failed");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("review proceeds once the required check completes successfully", async () => {
    const harness = createHarness({
      repo: {
        checks: [{ conclusion: null, name: "ci", status: "in_progress" }],
      },
      reviews: [clean],
    });

    const waiting = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(waiting.status).toBe("waiting_ci");
    expect(harness.model.calls).toHaveLength(0);

    harness.fakeGitHub.state.checks = [
      { conclusion: "success", name: "ci", status: "completed" },
    ];

    const resumed = await handleFrontierEvent(
      harness.deps,
      pullRequestEvent({ action: "completed", kind: "check_run" })
    );

    expect(resumed.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("scenario I — unrelated optional check pending", () => {
  test("an optional pending check does not block the frontier review", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          { conclusion: "success", name: "ci", status: "completed" },
          { conclusion: null, name: "preview-deploy", status: "in_progress" },
        ],
      },
      reviews: [clean],
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("scenario J — budget exhausted", () => {
  test("fails before the request with no fallback model", async () => {
    const harness = createHarness({
      budget: {
        dailyUsd: 5,
        inputUsdPerMTok: 1.4,
        maxCallUsd: 0.5,
        monthlyUsd: 50,
        outputUsdPerMTok: 4.4,
      },
    });
    await harness.kv.set(dayKey(HARNESS_NOW), {
      calls: 4,
      costUsd: 4.9,
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("budget_exhausted");
    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe(
      "action_required"
    );
  });
});

describe("hard invariant — third paid call is impossible", () => {
  test("after two reviews every further event is free", async () => {
    const harness = createHarness({ reviews: [changesRequired(), clean] });
    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    expect(harness.model.calls).toHaveLength(2);

    await pushRepair(harness, "head0003");
    await pushRepair(harness, "head0004");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0004" })
    );

    expect(harness.model.calls).toHaveLength(2);
  });
});

describe("gate configuration", () => {
  test("never_review wins over a review signal", async () => {
    const harness = createHarness({
      repo: {
        config: "frontier:\n  never_review:\n    - 'lib/**'\n",
        files: [
          {
            additions: 1,
            deletions: 0,
            path: "lib/model.ts",
            status: "modified",
          },
        ],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("skipped");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("always_review forces a review regardless of threshold", async () => {
    const harness = createHarness({
      repo: {
        config: "frontier:\n  always_review:\n    - 'lib/**'\n",
        files: [
          {
            additions: 1,
            deletions: 0,
            path: "lib/thing.ts",
            status: "modified",
          },
        ],
      },
      reviews: [clean],
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });
});

describe("budget reservation", () => {
  test("the reservation is derived from the caps, not just the floor", async () => {
    // A high output price makes the derived bound exceed the daily ceiling,
    // even though the 0.5 floor alone would have allowed the review.
    const harness = createHarness({
      budget: {
        dailyUsd: 3,
        inputUsdPerMTok: 1.4,
        maxCallUsd: 0.5,
        monthlyUsd: 50,
        outputUsdPerMTok: 1000,
      },
      reviews: [clean],
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("budget_exhausted");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("the ledger records the real cost, not the reservation", async () => {
    const harness = createHarness({ reviews: [clean] });

    await handleFrontierEvent(harness.deps, pullRequestEvent());

    const ledger = await harness.kv.get<{ calls: number; costUsd: number }>(
      dayKey(HARNESS_NOW)
    );

    expect(ledger).toEqual({ calls: 1, costUsd: DEFAULT_USAGE.costUsd });
  });

  test("an unsafe packet releases nothing because nothing was reserved", async () => {
    const harness = createHarness({
      repo: { diff: "+x".repeat(200_000) },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("needs_manual_review");
    const spend = await readSpend(harness.kv, HARNESS_NOW);

    expect(spend.daily.costUsd).toBe(0);
  });

  test("concurrent reviews for different PRs cannot overshoot the ceiling", async () => {
    const kv = createMemoryKv();
    const budget = {
      dailyUsd: 1,
      inputUsdPerMTok: 0,
      maxCallUsd: 0.5,
      monthlyUsd: 5,
      outputUsdPerMTok: 0,
    };
    const first = createHarness({ budget, kv, reviews: [clean] });
    const second = createHarness({ budget, kv, reviews: [clean] });

    const outcomes = await Promise.all([
      handleFrontierEvent(first.deps, pullRequestEvent({ prNumber: 7 })),
      handleFrontierEvent(second.deps, pullRequestEvent({ prNumber: 8 })),
    ]);

    const paidCalls = first.model.calls.length + second.model.calls.length;
    const spend = await readSpend(kv, HARNESS_NOW);

    expect(paidCalls).toBe(1);
    expect(outcomes.length).toBe(2);
    expect(spend.daily.costUsd).toBeLessThanOrEqual(budget.dailyUsd);
    expect(spend.daily.calls).toBe(1);
  });
});
