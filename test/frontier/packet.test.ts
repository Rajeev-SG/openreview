import { describe, expect, test } from "bun:test";

import { DEFAULT_FRONTIER_LIMITS } from "@/lib/frontier/config";
import {
  buildPacket,
  redactSecrets,
  renderFindingsMarkdown,
} from "@/lib/frontier/packet";

import { finding } from "./harness";

const base = {
  baseSha: "base",
  body: "Closes #1",
  ciEvidence: ["ci: success"],
  contextFiles: [],
  diff: "diff --git a/x b/x\n+hello",
  files: [{ additions: 1, deletions: 0, path: "lib/x.ts", status: "modified" }],
  gateReasons: [{ detail: "model policy", signal: "model", weight: 5 }],
  headSha: "head",
  limits: DEFAULT_FRONTIER_LIMITS,
  linkedIssue: { body: "Do it", number: 1, title: "Do it" },
  prNumber: 1,
  repo: "acme/widgets",
  title: "T",
};

describe("redactSecrets", () => {
  test("removes credential-shaped values", () => {
    const input = [
      "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      'password = "hunter2hunter2"',
    ].join("\n");

    const { redacted, text } = redactSecrets(input);

    expect(redacted).toBe(true);
    expect(text).not.toContain("sk-or-v1-abcdefghijklmnop");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("hunter2hunter2");
  });

  test("leaves ordinary prose untouched", () => {
    const { redacted } = redactSecrets("The token bucket refills at 10 rps.");
    expect(redacted).toBe(false);
  });
});

describe("buildPacket", () => {
  test("includes intent, interfaces, evidence and a bounded diff", () => {
    const packet = buildPacket({
      ...base,
      contextFiles: [{ content: "export type X = 1;", path: "lib/types.ts" }],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("## PR description");
    expect(packet.text).toContain("## Gate reasons");
    expect(packet.text).toContain("## CI / test evidence");
    expect(packet.text).toContain("lib/types.ts");
    expect(packet.hash).toHaveLength(40);
  });

  test("truncates an oversized diff but stays safe", () => {
    const packet = buildPacket({
      ...base,
      diff: "+x".repeat(1400),
      limits: { ...DEFAULT_FRONTIER_LIMITS, maxDiffChars: 1000 },
    });

    expect(packet.stats.truncated).toBe(true);
    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("truncated");
  });

  test("refuses to send an unrepresentative packet", () => {
    const packet = buildPacket({
      ...base,
      diff: "+x".repeat(120_000),
      limits: { ...DEFAULT_FRONTIER_LIMITS, maxDiffChars: 1000 },
    });

    expect(packet.unsafe).toBe(true);
    expect(packet.reason).toContain("raw diff");
  });

  test("refuses to send a packet with too many changed files", () => {
    const packet = buildPacket({
      ...base,
      files: Array.from({ length: 120 }, (_value, index) => ({
        additions: 1,
        deletions: 0,
        path: `src/f${index}.ts`,
        status: "modified",
      })),
    });

    expect(packet.unsafe).toBe(true);
  });

  test("delta packet carries the original findings and drops the file list", () => {
    const packet = buildPacket({
      ...base,
      delta: { fromSha: "shaA", originalFindings: [finding()] },
    });

    expect(packet.text).toContain("Delta review (#2)");
    expect(packet.text).toContain("F1");
    expect(packet.text).not.toContain("## Changed files");
  });

  test("caps the number of context files", () => {
    const packet = buildPacket({
      ...base,
      contextFiles: Array.from({ length: 20 }, (_value, index) => ({
        content: "const x = 1;",
        path: `src/c${index}.ts`,
      })),
      limits: { ...DEFAULT_FRONTIER_LIMITS, maxContextFiles: 2 },
    });

    expect(packet.stats.contextFiles).toBe(2);
  });
});

describe("renderFindingsMarkdown", () => {
  test("renders each required field", () => {
    const markdown = renderFindingsMarkdown([finding()]);
    expect(markdown).toContain("**Problem:**");
    expect(markdown).toContain("**Required fix:**");
    expect(markdown).toContain("**Verification:**");
  });

  test("handles an empty list", () => {
    expect(renderFindingsMarkdown([])).toContain("No material findings");
  });
});
