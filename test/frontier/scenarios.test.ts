import { describe, expect, test } from "bun:test";

import { dayKey, readSpend } from "@/lib/frontier/budget";
import { handleFrontierEvent } from "@/lib/frontier/engine";
import type { FrontierOutcome } from "@/lib/frontier/engine";
import { createMemoryKv } from "@/lib/frontier/store";
import type { FrontierKv } from "@/lib/frontier/store";
import { FINAL_SIGNAL_LABEL, NEW_CYCLE_LABEL } from "@/lib/frontier/types";
import type { FrontierReview } from "@/lib/frontier/types";

import {
  createHarness,
  DEFAULT_USAGE,
  failFirstAttempt,
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

describe("scenario: mixed code + lockfile PR (ad-platform-intelligence #18 shape)", () => {
  test("a huge lockfile does not refuse or skip the reviewable code", async () => {
    // Regression for the motivating failure: a real code change plus a ~600k-char
    // uv.lock diff was refused as `needs_manual_review` (`raw diff >10x cap`)
    // before the fix. Now the gate scores the code, packet assembly drops the
    // lockfile section, and review #1 runs once on a safe packet.
    const lockfileSection = `diff --git a/uv.lock b/uv.lock
--- a/uv.lock
+++ b/uv.lock
@@ -1,1 +1,2 @@
${"+".padEnd(600_000, "x")}
`;
    const codeSection = `diff --git a/src/pipeline/run.py b/src/pipeline/run.py
--- a/src/pipeline/run.py
+++ b/src/pipeline/run.py
@@ -1,1 +1,2 @@
+def run():
`;

    const harness = createHarness({
      repo: {
        diff: lockfileSection + codeSection,
        files: [
          {
            additions: 2740,
            deletions: 0,
            path: "uv.lock",
            status: "modified",
          },
          {
            additions: 40,
            deletions: 2,
            path: "src/pipeline/run.py",
            status: "modified",
          },
        ],
      },
      reviews: [clean],
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    // The code is judged; the packet is safe despite the oversized lockfile.
    expect(outcome.status).toBe("passed");
    expect(outcome.calls).toBe(1);
    expect(harness.model.calls).toHaveLength(1);
    expect(harness.model.calls[0]?.user).toContain("def run()");
    expect(harness.model.calls[0]?.user).toContain("uv.lock");
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.conclusion).toBe("success");
    expect(String(last?.summary)).not.toContain("could not be built safely");
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
  test("a delivery that fails is not marked done, so a retry can finish it", async () => {
    const harness = createHarness({ reviews: [clean] });
    const flaky = failFirstAttempt(harness.deps.github.setFrontierCheck);
    const deps = {
      ...harness.deps,
      github: { ...harness.deps.github, setFrontierCheck: flaky.fn },
    };

    const event = pullRequestEvent({ deliveryId: "delivery-retry-1" });

    await expect(handleFrontierEvent(deps, event)).rejects.toThrow();
    expect(flaky.calls()).toBe(1);

    // The retry is not written off as a duplicate, and it completes the event.
    const retry = await handleFrontierEvent(deps, event);

    expect(retry.status).toBe("passed");
    const marker = await harness.kv.get<number>(
      "frontier:delivery:delivery-retry-1"
    );

    expect(marker).toBe(1);
  });

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

describe("durable state requirement", () => {
  test("fails closed with zero spend when the store is ephemeral", async () => {
    const harness = createHarness({ reviews: [clean] });
    // A store that throws on every access, to prove the guard runs first.
    const exploding: FrontierKv = {
      delete: () => {
        throw new Error("kv must not be touched");
      },
      get: () => {
        throw new Error("kv must not be touched");
      },
      set: () => {
        throw new Error("kv must not be touched");
      },
    };
    const deps = {
      ...harness.deps,
      isDurableState: false,
      kv: exploding,
    };

    const outcome = await handleFrontierEvent(deps, pullRequestEvent());

    expect(outcome.status).toBe("needs_durable_state");
    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("neutral");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.summary).toContain(
      "REDIS_URL"
    );
  });
});

describe("required CI cannot be read", () => {
  test("fails closed with zero spend rather than reviewing ungated", async () => {
    const harness = createHarness({
      repo: {
        requiredUnknown:
          "the GitHub App cannot read branch protection (it needs repository 'administration' permission)",
      },
      reviews: [clean],
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("needs_manual_review");
    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe(
      "action_required"
    );
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.summary).toContain(
      "administration"
    );
  });
});

describe("a required check that never reports", () => {
  test("fails closed after the bounded wait instead of parking forever", async () => {
    const harness = createHarness({
      repo: {
        checks: [{ conclusion: null, name: "ci", status: "in_progress" }],
      },
      reviews: [clean],
    });

    // Seed a state that has already been waiting well past the bound.
    await harness.kv.set("frontier:pr:acme/widgets#7", {
      // Relative to the harness clock, not wall-clock: the engine compares
      // against deps.now().
      ciWaitingSince: new Date(
        HARNESS_NOW.getTime() - 60 * 60 * 1000
      ).toISOString(),
      cycleId: 1,
      headSha: "head0001",
      lifecycle: "waiting_ci",
      packetHashes: [],
      prNumber: 7,
      repo: "acme/widgets",
      reviewCount: 0,
      reviews: [],
      updatedAt: HARNESS_NOW.toISOString(),
      version: 1,
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("needs_manual_review");
    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(0);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe(
      "action_required"
    );
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.summary).toContain(
      "never reported"
    );
  });
});

describe("a passing verdict must not hide what the model reported", () => {
  test("a pass carrying blocking findings is not reported as a green check", async () => {
    // The exact shape of codex-home#65: verdict "pass", severity P1, check read
    // as success, PR merged 85 seconds later with the finding outstanding.
    // A blocking finding contradicts a pass verdict, and the final review
    // already refuses a pass in that case, so neither may look mergeable.
    const contradictory: FrontierReview = {
      findings: [finding({ severity: "P1" })],
      summary: "Passing, but the guard's core predicate over-triggers.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [contradictory] });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("waiting_final_signal");
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.conclusion).toBe("action_required");
    expect(last?.title).toContain("blocking");
    // F2 from the gate's own review: a title leading with "passed" tells a
    // human the opposite of what the conclusion enforces.
    expect(last?.title).not.toContain("passed");
    // The machine-readable verdict is the contract external consumers use.
    expect(last?.details).toContain("verdict=blocked");
    expect(last?.details).toContain("blocking=1");
  });

  test("the contradictory-pass path completes: fix, final signal, delta review", async () => {
    // F1/F4 from the gate's own review of this change: the new lifecycle was
    // only asserted at the first conclusion, and a parked state that cannot
    // re-review would be worse than the problem it replaces.
    //
    // This is a characterisation test, not a fail-first one: it passes against
    // the previous engine too, because the parked state reuses the existing
    // repair-then-signal flow rather than inventing one. It is here to pin that
    // the flow is reachable, which is what F1 said was unproven.
    const contradictory: FrontierReview = {
      findings: [finding({ id: "F1", severity: "P1" })],
      summary: "Passing, but the predicate over-triggers.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [contradictory, clean] });

    const first = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(first.status).toBe("waiting_final_signal");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe(
      "action_required"
    );

    // The finding is persisted on the engine state before the branch is chosen
    // (`state.findings = response.review.findings`), and `buildDelta` reads it as
    // `originalFindings`; the packet test "delta packet carries the original
    // findings" pins that baseline. What was previously unproven is that the
    // parked state can re-review at all, which is what the steps below show.

    // A repair push alone stays free, exactly as in the changes_required path.
    await pushRepair(harness, "head0002");
    expect(harness.model.calls).toHaveLength(1);

    // The final signal must actually re-review and clear.
    const final = await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    expect(harness.model.calls).toHaveLength(2);
    expect(final.status).toBe("passed");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.conclusion).toBe("success");
  });

  test("an advisory-only pass still reports success", async () => {
    const advisoryOnly: FrontierReview = {
      findings: [finding({ id: "F9", severity: "P3" })],
      summary: "Nit: naming.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [advisoryOnly] });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.conclusion).toBe("success");
    expect(last?.title).toContain("advisory");
  });

  test("findings attached to a pass are published on the check", async () => {
    // Observed live: a review returned verdict "pass" with a summary alleging a
    // regression, and the check title said "Frontier review passed". Findings
    // were persisted but never rendered, so the only place they existed was
    // prose a reader had to notice. A pass may legitimately carry advisory
    // items; dropping them is not a judgement call.
    const flagged: FrontierReview = {
      findings: [finding()],
      summary: "Advisory: consider the failure mode when the upstream is slow.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [flagged] });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("waiting_final_signal");
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    // P1 is blocking, so the conclusion is action_required (see the dedicated
    // test above); what matters here is that the finding is published at all.
    expect(last?.conclusion).toBe("action_required");
    expect(last?.details).toContain("F1");
    // The fixture finding is P1, so the label must say "blocking": the first
    // review passes on the verdict alone while the final review refuses a pass
    // with any blocking finding, and flattening severity to "advisory" would
    // report the gentler of two readings the gate itself does not treat alike.
    expect(last?.title).toContain("1 blocking finding");

    const advisory: FrontierReview = {
      findings: [finding({ id: "F2", severity: "P3" })],
      summary: "Nit: naming.",
      verdict: "pass",
    };
    const cleanTitle = createHarness({ reviews: [advisory] });
    await handleFrontierEvent(cleanTitle.deps, pullRequestEvent());
    expect(cleanTitle.fakeGitHub.checkUpdates.at(-1)?.title).toContain(
      "1 advisory finding"
    );
  });

  test("a clean pass keeps the plain title and carries only the verdict line", async () => {
    const harness = createHarness({ reviews: [clean] });

    await handleFrontierEvent(harness.deps, pullRequestEvent());

    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.title).toBe("Frontier review passed");
    // No findings to render, but the machine-readable verdict is always present
    // so an external consumer never has to parse the title.
    expect(last?.details).toContain("schema=frontier-verdict/v1");
    expect(last?.details).toContain("verdict=passed");
    expect(last?.details).toContain("blocking=0");
    expect(last?.details).not.toContain("####");
  });

  test("an unusable summary never reaches the check summary", async () => {
    // "..." and "" have both been observed from the judge. The check summary is
    // what a PR author reads, so it must say something.
    for (const summary of ["...", "   ", ""]) {
      const empty: FrontierReview = { findings: [], summary, verdict: "pass" };
      const harness = createHarness({ reviews: [empty] });

      await handleFrontierEvent(harness.deps, pullRequestEvent());

      const last = harness.fakeGitHub.checkUpdates.at(-1);
      expect(last?.summary).toBe("No material findings.");
    }
  });
});

describe("every surface that publishes the model's summary", () => {
  test("a degenerate summary is replaced on the PR comment too", async () => {
    // The check summary is not the only surface: a changes_required review also
    // posts review.summary as a PR comment, where a truthy "..." passed straight
    // through the old `|| fallback`.
    const harness = createHarness({
      reviews: [{ ...changesRequired(), summary: "..." }],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());

    const comment = harness.fakeGitHub.comments.at(-1);
    expect(comment).toBeDefined();
    expect(comment).toContain("_No summary provided._");
    expect(comment).not.toContain("## Frontier review\n\n...");
  });
});

describe("a passed cycle-complete check carries nothing outstanding", () => {
  test("a passed cycle reports no blocking counts and renders no findings", async () => {
    // The mirror of the erased-findings bug. `state.findings` is not cleared by
    // a successful resolution, so deriving the block from it alone would let a
    // passed cycle-complete check display blocking findings it just fixed -
    // `verdict=passed` beside `blocking=N`. A passed (or resolved) cycle has
    // nothing outstanding by definition, so it carries neither.
    // The final review PASSES but carries an advisory finding, so state.findings
    // is non-empty at the moment the cycle-complete write runs - which is what
    // makes this a real test of the gating rather than an empty-list coincidence.
    const passingWithAdvisory: FrontierReview = {
      findings: [finding({ id: "F9", severity: "P3" })],
      summary: "Nit only.",
      verdict: "pass",
    };
    const harness = createHarness({ reviews: [clean, passingWithAdvisory] });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    // Same-SHA event with the budget spent: reaches the cycle-complete write.
    await handleFrontierEvent(
      harness.deps,
      pullRequestEvent({ action: "synchronize", headSha: "head0002" })
    );

    const last = harness.fakeGitHub.checkUpdates.at(-1);
    const details = String(last?.details);
    expect(details).toContain("verdict=passed");
    expect(details).toContain("blocking=0");
    expect(details).toContain("advisory=0");
    // No rendered findings table.
    expect(details).not.toContain("| Finding | Severity |");
    expect(String(last?.title)).toBe("Frontier review passed (cycle complete)");
  });
});

describe("a spent budget must not erase the findings it is reporting", () => {
  test("the cycle-complete check carries the real findings and counts", async () => {
    // The write replaces the check run, so hardcoding 0/0 both contradicted
    // `verdict=blocked` and erased what the final review had just posted.
    const harness = createHarness({
      reviews: [changesRequired(), changesRequired([finding({ id: "F2" })])],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    // A same-SHA event with the budget spent and no repair push to resolve -
    // this is the path codex-home#81 hit, where the cycle-complete write
    // replaced the final review's check.
    await handleFrontierEvent(
      harness.deps,
      pullRequestEvent({ action: "synchronize", headSha: "head0002" })
    );

    const last = harness.fakeGitHub.checkUpdates.at(-1);
    const details = String(last?.details);
    expect(details).toContain("verdict=blocked");
    expect(details).toContain("blocking=1");
    // The findings themselves must survive the rewrite.
    expect(details).toContain("F2");
    expect(String(last?.title)).toContain("1 blocking finding");
  });
});

describe("a spent review budget must still leave a check on the head", () => {
  test("a push after the budget is spent produces a terminal check, not silence", async () => {
    // The deadlock: `settled()` creates no check run, so a push arriving after
    // the cycle's two reviews produced no `frontier-quality` check at all. On a
    // repository that requires that check, the PR became permanently
    // unmergeable - no further review would ever run to satisfy it.
    const harness = createHarness({ reviews: [clean, clean] });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    const updatesBefore = harness.fakeGitHub.checkUpdates.length;

    // A further push, with the cycle's budget now exhausted.
    await pushRepair(harness, "head0003");

    const after = harness.fakeGitHub.checkUpdates.slice(updatesBefore);
    expect(after.length).toBeGreaterThan(0);
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.status).toBe("completed");
    expect(last?.conclusion).toBe("success");
    expect(last?.details).toContain("budget");
  });

  test("a spent budget over outstanding findings does not report success", async () => {
    // The same contract must not become a way to launder a blocked cycle green.
    const harness = createHarness({
      reviews: [changesRequired(), changesRequired([finding({ id: "F2" })])],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());
    await pushRepair(harness, "head0002");
    await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "head0002" })
    );
    await pushRepair(harness, "head0003");

    // A blocked cycle takes the deterministic resolution path, which reports
    // failure; a blocked budget-spent cycle reports action_required. Either is
    // correct. What must never happen is a success.
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.status).toBe("completed");
    expect(["failure", "action_required"]).toContain(String(last?.conclusion));
  });
});

const CODE_DIFF = [
  "diff --git a/lib/policy.ts b/lib/policy.ts",
  "--- a/lib/policy.ts",
  "+++ b/lib/policy.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

describe("scenario B1 — required-check issuer binding (T02/T03)", () => {
  const codeFiles = [
    { additions: 10, deletions: 1, path: "lib/policy.ts", status: "modified" },
    {
      additions: 2,
      deletions: 0,
      path: "lib/policy.test.ts",
      status: "modified",
    },
  ];

  test("a same-named check from another App does not satisfy required CI", async () => {
    // A required context is only satisfied by the App the platform recorded for
    // it. A check run published by another App with the same name must not let
    // the gate conclude CI is green and spend a review.
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 999_999,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["verify"],
        requiredAppIds: { verify: 15_368 },
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(harness.model.calls).toHaveLength(0);
    expect(outcome.calls).toBe(0);
    // Not green: the real issuer has not reported, so the gate waits rather
    // than treating a spoofed context as evidence.
    expect(outcome.status).toBe("waiting_ci");
  });

  test("the expected issuer satisfies required CI and the review proceeds", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 15_368,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["verify"],
        requiredAppIds: { verify: 15_368 },
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });

  test("a context with no recorded issuer is still accepted from any App", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 42,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["verify"],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
  });

  test("per-repo required_checks policy gates a repo with no branch protection", async () => {
    // Private Free-plan repos cannot have branch protection, so the trusted
    // per-repo policy is the fallback. It must actually be applied.
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 15_368,
            conclusion: "failure",
            name: "verify",
            status: "completed",
          },
        ],
        config: "frontier:\n  required_checks:\n    - verify\n",
        diff: CODE_DIFF,
        files: codeFiles,
        required: [],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(harness.model.calls).toHaveLength(0);
    expect(outcome.status).toBe("ci_failed");
  });
});

describe("scenario B2 — reviewer findings on the Phase B change (PR #31)", () => {
  const codeFiles = [
    { additions: 10, deletions: 1, path: "lib/policy.ts", status: "modified" },
    {
      additions: 2,
      deletions: 0,
      path: "lib/policy.test.ts",
      status: "modified",
    },
  ];

  test("F1: a per-repo policy cannot remove a platform requirement", async () => {
    // The reviewer's finding: a repository-committed file is only as
    // trustworthy as write access to the default branch, so it must not be
    // able to delete a requirement the platform imposes. `required_checks: []`
    // adds nothing; it does not clear `verify`.
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 15_368,
            conclusion: "failure",
            name: "verify",
            status: "completed",
          },
        ],
        config: "frontier:\n  required_checks: []\n",
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["verify"],
        requiredAppIds: { verify: 15_368 },
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("ci_failed");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("F1: a per-repo policy may add a requirement the platform does not impose", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 15_368,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        config:
          "frontier:\n  required_checks:\n    - extra-lint\n  required_check_apps:\n    extra-lint: 15368\n",
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["verify"],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    // `extra-lint` has not reported, so the added requirement blocks spend.
    expect(outcome.status).toBe("waiting_ci");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("F3: a foreign-App check cannot satisfy a pinned per-repo policy", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 999_999,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        config:
          "frontier:\n  required_checks:\n    - verify\n  required_check_apps:\n    verify: 15368\n",
        diff: CODE_DIFF,
        files: codeFiles,
        required: [],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("waiting_ci");
    expect(harness.model.calls).toHaveLength(0);
  });

  test("F3: the pinned issuer satisfies the per-repo policy", async () => {
    const harness = createHarness({
      repo: {
        checks: [
          {
            appId: 15_368,
            conclusion: "success",
            name: "verify",
            status: "completed",
          },
        ],
        config:
          "frontier:\n  required_checks:\n    - verify\n  required_check_apps:\n    verify: 15368\n",
        diff: CODE_DIFF,
        files: codeFiles,
        required: [],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });

  test("F5: a legacy commit-status context is real evidence, not an endless wait", async () => {
    // Branch protection can require a classic commit status. That is
    // unsatisfiable by the check-run API, so it is read from the status API;
    // a green status must let the review proceed.
    const harness = createHarness({
      repo: {
        checks: [],
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["ci/status"],
        statuses: [{ context: "ci/status", state: "success" }],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("passed");
    expect(harness.model.calls).toHaveLength(1);
  });

  test("F5: a failing legacy commit status blocks spend", async () => {
    const harness = createHarness({
      repo: {
        checks: [],
        diff: CODE_DIFF,
        files: codeFiles,
        required: ["ci/status"],
        statuses: [{ context: "ci/status", state: "failure" }],
      },
    });

    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());

    expect(outcome.status).toBe("ci_failed");
    expect(harness.model.calls).toHaveLength(0);
  });
});

describe("scenario C1 — transient provider failure is recoverable (T12/T13)", () => {
  const codeFiles = [
    { additions: 10, deletions: 1, path: "lib/policy.ts", status: "modified" },
    {
      additions: 2,
      deletions: 0,
      path: "lib/policy.test.ts",
      status: "modified",
    },
  ];

  const repo = () => ({
    checks: [
      {
        appId: 15_368,
        conclusion: "success",
        name: "verify",
        status: "completed",
      },
    ],
    diff: CODE_DIFF,
    files: codeFiles,
    required: ["verify"],
    requiredAppIds: { verify: 15_368 },
  });

  test("a failed final review re-arms the signal label so the retry is one re-add", async () => {
    const harness = createHarness({
      repo: repo(),
      reviews: [
        {
          findings: [finding()],
          summary: "One material problem.",
          verdict: "changes_required",
        },
        clean,
      ],
    });

    // The engine's own final-review call fails outright, which is what a
    // persistent provider fault looks like after the client's retries.
    // Review #1 uses the queued review; the final review always fails with the
    // production provider error.
    const { model: realModel } = harness.model;
    const failure = new Error("OpenRouter returned an empty completion");
    const reject = async (): Promise<never> => {
      await Promise.resolve();
      throw failure;
    };
    const responses = [
      (request: Parameters<typeof realModel.review>[0]) =>
        realModel.review(request),
      reject,
      reject,
    ];
    let call = -1;
    harness.deps.model = {
      review: (request) => {
        call += 1;
        return responses[Math.min(call, responses.length - 1)](request);
      },
    };

    const first = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(first.status).toBe("waiting_final_signal");

    await pushRepair(harness, "repair0001");
    const second = await handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: "repair0001" })
    );

    expect(second.status).toBe("needs_manual_review");
    // The one-shot label is consumed, so a re-add fires a real `labeled` event
    // instead of being an invisible no-op.
    expect(harness.fakeGitHub.removedLabels).toContain(FINAL_SIGNAL_LABEL);
    const last = harness.fakeGitHub.checkUpdates.at(-1);
    expect(last?.title).toBe("Frontier final review failed");
    expect(last?.summary).toContain(FINAL_SIGNAL_LABEL);
  });

  test("an empty completion is classified as retryable by the model client", async () => {
    // The production failure: a 200 with no completion was treated as
    // permanent, so the client never retried and the PR stranded in
    // needs_manual_review. It is a transient provider fault.
    const { createOpenRouterFrontierModel } =
      await import("@/lib/frontier/model");
    const responses = [
      () => Response.json({ choices: [{ message: { content: "" } }] }),
      () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [],
                  summary: "Fine.",
                  verdict: "pass",
                }),
              },
            },
          ],
          usage: { completion_tokens: 5, cost: 0.001, prompt_tokens: 10 },
        }),
    ];
    let attempts = 0;
    const fetchImpl = (async () => {
      await Promise.resolve();
      const next = responses[Math.min(attempts, responses.length - 1)];
      attempts += 1;
      return next();
    }) as unknown as typeof fetch;

    const client = createOpenRouterFrontierModel({
      apiKey: "test",
      fetchImpl,
      maxAttempts: 2,
      model: "z-ai/glm-5.3",
    });

    const response = await client.review({
      maxTokens: 100,
      system: "s",
      user: "u",
    });

    expect(attempts).toBe(2);
    expect(response.review.verdict).toBe("pass");
  });
});

describe("scenario C2 — no paid call for a non-substantive repair (T07)", () => {
  const repo = () => ({
    checks: [
      {
        appId: 15_368,
        conclusion: "success",
        name: "verify",
        status: "completed",
      },
    ],
    diff: CODE_DIFF,
    files: [
      {
        additions: 10,
        deletions: 1,
        path: "lib/policy.ts",
        status: "modified",
      },
      {
        additions: 2,
        deletions: 0,
        path: "lib/policy.test.ts",
        status: "modified",
      },
    ],
    required: ["verify"],
    requiredAppIds: { verify: 15_368 },
  });

  const changelogDiff = [
    "diff --git a/CHANGELOG.md b/CHANGELOG.md",
    "--- a/CHANGELOG.md",
    "+++ b/CHANGELOG.md",
    "@@ -1,2 +1,3 @@",
    " entry",
    "+another entry",
  ].join("\n");

  const lockfileOnlyDiff = [
    "diff --git a/bun.lock b/bun.lock",
    "--- a/bun.lock",
    "+++ b/bun.lock",
    "@@ -1,2 +1,2 @@",
    "-a",
    "+b",
  ].join("\n");

  const reviewWithFindings = () =>
    createHarness({
      repo: repo(),
      reviews: [
        {
          findings: [finding()],
          summary: "One problem.",
          verdict: "changes_required",
        },
      ],
    });

  const firstReview = async (harness: ReturnType<typeof createHarness>) => {
    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(outcome.status).toBe("waiting_final_signal");
    return harness;
  };

  const signal = (harness: ReturnType<typeof createHarness>, head: string) => {
    harness.fakeGitHub.state.pr = {
      ...harness.fakeGitHub.state.pr,
      headSha: head,
    };
    return handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: head })
    );
  };

  test("a changelog-only repair consumes no paid slot", async () => {
    const harness = await firstReview(reviewWithFindings());
    harness.fakeGitHub.state.deltaDiffs = {
      "head0001..changelog1": changelogDiff,
    };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "CHANGELOG.md", status: "modified" },
    ];

    const outcome = await signal(harness, "changelog1");

    expect(outcome.calls).toBe(0);
    expect(outcome.status).toBe("waiting_final_signal");
    expect(harness.model.calls).toHaveLength(1);
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.title).toBe(
      "Frontier final review skipped: no substantive repair"
    );
  });

  test("a lockfile-only repair consumes no paid slot", async () => {
    const harness = await firstReview(reviewWithFindings());
    harness.fakeGitHub.state.deltaDiffs = {
      "head0001..lockfile1": lockfileOnlyDiff,
    };

    const outcome = await signal(harness, "lockfile1");

    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(1);
  });

  test("an empty delta consumes no paid slot", async () => {
    const harness = await firstReview(reviewWithFindings());
    harness.fakeGitHub.state.deltaDiffs = { "head0001..emptyhead1": "" };
    harness.fakeGitHub.state.deltaFiles = [];

    const outcome = await signal(harness, "emptyhead1");

    expect(outcome.calls).toBe(0);
    expect(harness.model.calls).toHaveLength(1);
  });

  test("a later substantive repair still receives the final review", async () => {
    const harness = await firstReview(reviewWithFindings());
    harness.fakeGitHub.state.deltaDiffs = {
      "head0001..changelog1": changelogDiff,
      "head0001..realrepair": CODE_DIFF,
    };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "CHANGELOG.md", status: "modified" },
    ];

    const refused = await signal(harness, "changelog1");
    expect(refused.calls).toBe(0);

    // The cycle is not stranded: a real fix gets the paid final review.
    const reviewed = await signal(harness, "realrepair");

    expect(reviewed.calls).toBe(1);
    expect(harness.model.calls).toHaveLength(2);
  });
});

describe("scenario C3 — repair-delta classification is not fooled (T07 follow-ups)", () => {
  const repo = () => ({
    checks: [
      {
        appId: 15_368,
        conclusion: "success",
        name: "verify",
        status: "completed",
      },
    ],
    diff: CODE_DIFF,
    files: [
      {
        additions: 10,
        deletions: 1,
        path: "lib/policy.ts",
        status: "modified",
      },
      {
        additions: 2,
        deletions: 0,
        path: "lib/policy.test.ts",
        status: "modified",
      },
    ],
    required: ["verify"],
    requiredAppIds: { verify: 15_368 },
  });

  const firstReview = async (harness: ReturnType<typeof createHarness>) => {
    const outcome = await handleFrontierEvent(harness.deps, pullRequestEvent());
    expect(outcome.status).toBe("waiting_final_signal");
  };

  const signal = (harness: ReturnType<typeof createHarness>, head: string) => {
    harness.fakeGitHub.state.pr = {
      ...harness.fakeGitHub.state.pr,
      headSha: head,
    };
    return handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: head })
    );
  };

  const withFindings = () =>
    createHarness({
      repo: repo(),
      reviews: [
        {
          findings: [finding()],
          summary: "One problem.",
          verdict: "changes_required",
        },
      ],
    });

  test("T07-1: an empty diff with changes reported is indeterminate, not 'nothing changed'", async () => {
    const harness = withFindings();
    await firstReview(harness);
    // The diff payload is missing, but the compare API knows files changed.
    harness.fakeGitHub.state.deltaDiffs = { "head0001..mystery1": "" };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "lib/policy.ts", status: "modified" },
    ];

    const outcome = await signal(harness, "mystery1");

    // Recoverable, not parked: a transient API problem must not cost the cycle.
    expect(outcome.status).toBe("waiting_final_signal");
    expect(harness.fakeGitHub.checkUpdates.at(-1)?.title).toBe(
      "Frontier final review could not verify the delta"
    );
    expect(harness.model.calls).toHaveLength(1);
  });

  test("T07-1: an unreadable file list is indeterminate, not 'nothing changed'", async () => {
    const harness = withFindings();
    await firstReview(harness);
    harness.fakeGitHub.state.deltaDiffs = { "head0001..unknown1": "" };
    harness.fakeGitHub.state.deltaFiles = "unknown";

    const outcome = await signal(harness, "unknown1");

    expect(outcome.status).toBe("waiting_final_signal");
    expect(harness.model.calls).toHaveLength(1);
  });

  test("T07-2: a deletion-only repair is not described as 'no reviewable change'", async () => {
    const harness = withFindings();
    await firstReview(harness);
    harness.fakeGitHub.state.deltaDiffs = {
      "head0001..deleted1": [
        "diff --git a/lib/policy.ts b/lib/policy.ts",
        "deleted file mode 100644",
        "--- a/lib/policy.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-const a = 1;",
        "-const b = 2;",
      ].join("\n"),
    };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "lib/policy.ts", status: "removed" },
    ];

    const outcome = await signal(harness, "deleted1");

    const title = harness.fakeGitHub.checkUpdates.at(-1)?.title;
    expect(title).toContain("deletion-only");
    expect(title).not.toContain("no substantive repair");
    expect(outcome.calls).toBe(0);
    // Also recoverable, so the documented re-signal path works.
    expect(outcome.status).toBe("waiting_final_signal");
  });

  test("T07-3: an explicit force-review is not swallowed by the substantiveness refusal", async () => {
    // `frontier-review` routes through the ordinary evaluate path, not the
    // final-review path, so it must still reach the model.
    const harness = withFindings();
    await firstReview(harness);
    harness.fakeGitHub.state.deltaDiffs = { "head0001..forced001": "" };
    harness.fakeGitHub.state.deltaFiles = [];
    harness.fakeGitHub.state.pr = {
      ...harness.fakeGitHub.state.pr,
      headSha: "forced001",
    };

    const before = harness.model.calls.length;
    const outcome = await handleFrontierEvent(
      harness.deps,
      labelEvent("frontier-review", { headSha: "forced001" })
    );

    const title = harness.fakeGitHub.checkUpdates.at(-1)?.title;
    expect(title).not.toContain("no substantive repair");
    // The override must actually reach the model rather than being swallowed.
    expect(harness.model.calls.length).toBeGreaterThan(before);
    expect(outcome.calls).toBeGreaterThan(0);
  });
});

describe("scenario C4 — force-review is honoured but stays inside the budget", () => {
  const repo = () => ({
    checks: [
      {
        appId: 15_368,
        conclusion: "success",
        name: "verify",
        status: "completed",
      },
    ],
    diff: CODE_DIFF,
    files: [
      {
        additions: 10,
        deletions: 1,
        path: "lib/policy.ts",
        status: "modified",
      },
      {
        additions: 2,
        deletions: 0,
        path: "lib/policy.test.ts",
        status: "modified",
      },
    ],
    required: ["verify"],
    requiredAppIds: { verify: 15_368 },
  });

  test("repeated force labels cannot spend more than the cycle allowance", async () => {
    const harness = createHarness({
      repo: repo(),
      reviews: [
        {
          findings: [finding()],
          summary: "One problem.",
          verdict: "changes_required",
        },
        {
          findings: [finding()],
          summary: "Still a problem.",
          verdict: "changes_required",
        },
        { findings: [], summary: "Fine now.", verdict: "pass" },
        { findings: [], summary: "Fine now.", verdict: "pass" },
      ],
    });

    await handleFrontierEvent(harness.deps, pullRequestEvent());

    // Force it several times; each push/head change would otherwise be a fresh
    // opportunity to spend.
    for (const head of ["forced1", "forced2", "forced3"]) {
      harness.fakeGitHub.state.pr = {
        ...harness.fakeGitHub.state.pr,
        headSha: head,
      };
      harness.fakeGitHub.state.deltaDiffs = {
        [`head0001..${head}`]: CODE_DIFF,
      };
      harness.fakeGitHub.state.deltaFiles = [
        { path: "lib/policy.ts", status: "modified" },
      ];
      await handleFrontierEvent(
        harness.deps,
        labelEvent("frontier-review", { headSha: head })
      );
    }

    // At most two paid calls in the cycle, however often the label is applied.
    expect(harness.model.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("scenario C5 — the second signal is reconciled, not just presence-checked", () => {
  const repo = () => ({
    checks: [
      {
        appId: 15_368,
        conclusion: "success",
        name: "verify",
        status: "completed",
      },
    ],
    diff: CODE_DIFF,
    files: [
      {
        additions: 10,
        deletions: 1,
        path: "lib/policy.ts",
        status: "modified",
      },
      {
        additions: 2,
        deletions: 0,
        path: "lib/policy.test.ts",
        status: "modified",
      },
    ],
    required: ["verify"],
    requiredAppIds: { verify: 15_368 },
  });

  const withFindings = () =>
    createHarness({
      repo: repo(),
      reviews: [
        {
          findings: [finding()],
          summary: "One problem.",
          verdict: "changes_required",
        },
        { findings: [], summary: "Fine.", verdict: "pass" },
      ],
    });

  const firstReview = async (harness: ReturnType<typeof createHarness>) => {
    await handleFrontierEvent(harness.deps, pullRequestEvent());
  };

  const signal = (harness: ReturnType<typeof createHarness>, head: string) => {
    harness.fakeGitHub.state.pr = {
      ...harness.fakeGitHub.state.pr,
      headSha: head,
    };
    return handleFrontierEvent(
      harness.deps,
      labelEvent(FINAL_SIGNAL_LABEL, { headSha: head })
    );
  };

  test("F1: a partially-parsed diff is reconciled against the signal", async () => {
    // The diff parses to a low-value path only (a changelog hunk survived a
    // truncated payload) while the compare API reports a real source change.
    // Trusting the parse would refuse a genuine repair as "nothing changed".
    const harness = withFindings();
    await firstReview(harness);
    harness.fakeGitHub.state.deltaDiffs = {
      "head0001..partial01": [
        "diff --git a/CHANGELOG.md b/CHANGELOG.md",
        "--- a/CHANGELOG.md",
        "+++ b/CHANGELOG.md",
        "@@ -1,2 +1,3 @@",
        " entry",
        "+another entry",
      ].join("\n"),
    };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "CHANGELOG.md", status: "modified" },
      { path: "lib/policy.ts", status: "modified" },
    ];

    const outcome = await signal(harness, "partial01");

    const title = harness.fakeGitHub.checkUpdates.at(-1)?.title;
    expect(title).not.toBe(
      "Frontier final review skipped: no substantive repair"
    );
    expect(title).toBe("Frontier final review could not verify the delta");
    expect(outcome.status).toBe("waiting_final_signal");
  });

  test("F3: an indeterminate refusal is recoverable by re-signalling", async () => {
    const harness = withFindings();
    await firstReview(harness);

    // First attempt: the delta cannot be read.
    harness.fakeGitHub.state.deltaDiffs = { "head0001..retry001": "" };
    harness.fakeGitHub.state.deltaFiles = "unknown";
    const first = await signal(harness, "retry001");
    expect(first.status).toBe("waiting_final_signal");
    expect(harness.model.calls).toHaveLength(1);

    // The API recovers; the same head now reports a real change.
    harness.fakeGitHub.state.deltaDiffs = { "head0001..retry001": CODE_DIFF };
    harness.fakeGitHub.state.deltaFiles = [
      { path: "lib/policy.ts", status: "modified" },
    ];
    const second = await signal(harness, "retry001");

    expect(second.calls).toBe(1);
    expect(harness.model.calls).toHaveLength(2);
  });
});
