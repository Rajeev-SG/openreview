import { describe, expect, test } from "bun:test";

import { isRepoInSet, normalizeRepoName } from "@/lib/frontier/canary-probe";

describe("normalizeRepoName", () => {
  test("lowercases and trims a repository name", () => {
    expect(normalizeRepoName("  Rajeev-SG/OpenReview ")).toBe(
      "rajeev-sg/openreview"
    );
  });
});

describe("isRepoInSet", () => {
  test("matches a declared repository", () => {
    expect(isRepoInSet("rajeev-sg/openreview", ["rajeev-sg/openreview"])).toBe(
      true
    );
  });

  test("rejects a repository that is not declared", () => {
    expect(isRepoInSet("rajeev-sg/other", ["rajeev-sg/openreview"])).toBe(
      false
    );
  });
});
