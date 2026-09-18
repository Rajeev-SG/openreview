import { describe, expect, test } from "bun:test";

import { canaryIsGatedRepo, canaryNormalizeRepo } from "@/lib/frontier/canary-probe";

describe("canary probe", () => {
  test("normalises and matches a gated repo", () => {
    expect(canaryNormalizeRepo("  Rajeev-SG/OpenReview ")).toBe("rajeev-sg/openreview");
    expect(canaryIsGatedRepo("rajeev-sg/openreview", ["rajeev-sg/openreview"])).toBe(true);
  });
});
