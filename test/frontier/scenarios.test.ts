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
