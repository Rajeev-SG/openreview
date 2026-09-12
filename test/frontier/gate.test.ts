import { describe, expect, test } from "bun:test";

import { readFrontierLimits, parseRepoConfig } from "@/lib/frontier/config";
import { evaluateGate } from "@/lib/frontier/gate";
import type { GateChangedFile } from "@/lib/frontier/gate";

const file = (
  path: string,
  overrides: Partial<GateChangedFile> = {}
): GateChangedFile => ({
  additions: 1,
  deletions: 0,
  path,
  status: "modified",
  ...overrides,
});

const config = {
  alwaysReview: [],
  enabled: true,
  neverReview: [],
  threshold: 5,
};

describe("evaluateGate", () => {
  test("README-only changes are skipped", () => {
    const decision = evaluateGate({
      config,
      files: [file("README.md"), file("docs/guide.md")],
      labels: [],
    });
    expect(decision.mode).toBe("skip");
    expect(decision.overridden).toBe("force_skip");
  });

  test("requirement and spec markdown is not ordinary documentation", () => {
    const decision = evaluateGate({
      config,
      files: [file("specs/frontier-review.md")],
      labels: [],
    });
    expect(decision.reasons.some((reason) => reason.weight > 0)).toBe(true);
  });

  test("prompt and agent changes trigger a review", () => {
    const decision = evaluateGate({
      config,
      files: [file("src/agents/planner.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("review");
  });

  test("benchmark and verifier changes trigger a review", () => {
    const decision = evaluateGate({
      config,
      files: [file("benchmarks/quality.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("review");
  });

  test("runtime code without tests triggers a review", () => {
    const decision = evaluateGate({
      config,
      files: [file("src/billing/invoice.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("review");
    expect(
      decision.reasons.some(
        (reason) => reason.signal === "runtime_without_tests"
      )
    ).toBe(true);
  });

  test("a test-only change is reviewed as verifier logic", () => {
    const decision = evaluateGate({
      config,
      files: [file("tests/symphony-gh-guard.test.ts")],
      labels: [],
    });

    expect(decision.mode).toBe("review");
    expect(
      decision.reasons.some(
        (reason) => reason.signal === "tests_verifier_logic"
      )
    ).toBe(true);
  });

  test("runtime code with a matching test does not add the missing-test signal", () => {
    const decision = evaluateGate({
      config,
      files: [file("src/billing/invoice.ts"), file("test/invoice.test.ts")],
      labels: [],
    });
    expect(
      decision.reasons.some(
        (reason) => reason.signal === "runtime_without_tests"
      )
    ).toBe(false);
  });

  test("never_review skips when every changed file matches", () => {
    const decision = evaluateGate({
      config: { ...config, neverReview: ["generated/**"] },
      files: [file("generated/schema.ts"), file("generated/client.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("skip");
    expect(decision.overridden).toBe("never_review");
  });

  test("never_review does not hide a review signal elsewhere in the diff", () => {
    const decision = evaluateGate({
      config: { ...config, neverReview: ["generated/**"] },
      files: [file("generated/schema.ts"), file("lib/model.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("review");
  });

  test("always_review overrides a low score", () => {
    const decision = evaluateGate({
      config: { ...config, alwaysReview: ["benchmarks/**"] },
      files: [file("benchmarks/score.ts")],
      labels: [],
    });
    expect(decision.mode).toBe("review");
    expect(decision.overridden).toBe("always_review");
  });

  test("a manual frontier-review label forces a review", () => {
    const decision = evaluateGate({
      config,
      files: [file("README.md")],
      labels: ["frontier-review"],
    });
    expect(decision.mode).toBe("review");
    expect(decision.overridden).toBe("label");
  });

  test("an empty diff is skipped", () => {
    expect(evaluateGate({ config, files: [], labels: [] }).mode).toBe("skip");
  });
});

describe("config parsing", () => {
  test("parses a frontier block", () => {
    const parsed = parseRepoConfig(
      "frontier:\n  enabled: true\n  threshold: 7\n  always_review:\n    - 'src/agents/**'\n"
    );
    expect(parsed.threshold).toBe(7);
    expect(parsed.alwaysReview).toEqual(["src/agents/**"]);
  });

  test("malformed config falls back to defaults", () => {
    expect(parseRepoConfig(":::not yaml:::").threshold).toBe(5);
  });

  test("the two-review invariant cannot be raised", () => {
    expect(
      readFrontierLimits({ FRONTIER_MAX_REVIEWS_PER_CYCLE: "9" })
        .maxReviewsPerCycle
    ).toBe(2);
  });

  test("defaults match the issue contract", () => {
    const limits = readFrontierLimits({});
    expect(limits.maxPacketChars).toBe(50_000);
    expect(limits.maxDiffChars).toBe(35_000);
    expect(limits.maxContextFiles).toBe(6);
    expect(limits.maxContextPerFileChars).toBe(4000);
    expect(limits.maxPrBodyChars).toBe(4000);
    expect(limits.maxLinkedIssueChars).toBe(5000);
    expect(limits.maxOutputTokens).toBe(3000);
  });
});
