import { describe, expect, test } from "bun:test";

import {
  classifyRequiredChecksFailure,
  withoutSelfCheck,
} from "@/lib/frontier/checks";

describe("withoutSelfCheck", () => {
  test("drops the gate's own check so it cannot deadlock waiting for itself", () => {
    expect(withoutSelfCheck(["ci", "frontier-quality"])).toEqual(["ci"]);
  });

  test("leaves an empty list when the gate is the only required check", () => {
    // The gate then has nothing to wait for and proceeds to review.
    expect(withoutSelfCheck(["frontier-quality"])).toEqual([]);
  });

  test("keeps other checks, de-duplicated and ordered", () => {
    expect(withoutSelfCheck(["ci", "ci", "lint", "frontier-quality"])).toEqual([
      "ci",
      "lint",
    ]);
  });

  test("ignores blank entries", () => {
    expect(withoutSelfCheck(["", undefined, null, "ci"])).toEqual(["ci"]);
  });
});

describe("classifyRequiredChecksFailure", () => {
  test("404 is genuine absence: nothing to wait for", () => {
    expect(classifyRequiredChecksFailure(404)).toBe("none");
  });

  test("403 is unreadable: the answer is unknown, not empty", () => {
    expect(classifyRequiredChecksFailure(403)).toBe("unreadable");
  });

  test("anything else is a real error and must surface", () => {
    expect(classifyRequiredChecksFailure(500)).toBe("throw");
    expect(classifyRequiredChecksFailure()).toBe("throw");
  });
});
