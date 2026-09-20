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

  test("truncates an oversized diff but stays safe, with an explicit banner", () => {
    const packet = buildPacket({
      ...base,
      diff: "+x".repeat(1400),
      limits: { ...DEFAULT_FRONTIER_LIMITS, maxDiffChars: 1000 },
    });

    expect(packet.stats.truncated).toBe(true);
    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("the diff below is truncated");
    expect(packet.text).toContain("changed-file list is complete");
  });

  test("reviews a large-but-representable PR rather than refusing it", () => {
    const packet = buildPacket({
      ...base,
      diff: "+x".repeat(10_000),
      limits: { ...DEFAULT_FRONTIER_LIMITS, maxDiffChars: 4000 },
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.stats.truncated).toBe(true);
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

const pad = (chars: number): string => "+".padEnd(chars, "x");

describe("buildPacket — mixed code + lockfile diffs", () => {
  // A representative extraction PR: a huge machine-generated uv.lock plus a
  // small hand-written source change. Lockfile churn must not make the packet
  // unrepresentative when the reviewable code is small.
  const lockfileSection = `diff --git a/uv.lock b/uv.lock
index 1111111..2222222 100644
--- a/uv.lock
+++ b/uv.lock
@@ -1,1 +1,2 @@
${pad(600_000)}
`;
  const codeSection = `diff --git a/src/pipeline.py b/src/pipeline.py
index aaaaaaa..bbbbbbb 100644
--- a/src/pipeline.py
+++ b/src/pipeline.py
@@ -1,1 +1,2 @@
+def crawl():
+    return render()
`;
  const schemaSection = `diff --git a/schemas/ISO-29500/dml-main.xsd b/schemas/ISO-29500/dml-main.xsd
index 3333333..4444444 100644
--- a/schemas/ISO-29500/dml-main.xsd
+++ b/schemas/ISO-29500/dml-main.xsd
@@ -1,1 +1,2 @@
${pad(600_000)}
`;

  test("excludes the lockfile diff but keeps the code diff and file list", () => {
    const packet = buildPacket({
      ...base,
      diff: lockfileSection + codeSection,
      files: [
        { additions: 2740, deletions: 0, path: "uv.lock", status: "modified" },
        {
          additions: 2,
          deletions: 0,
          path: "src/pipeline.py",
          status: "modified",
        },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("def crawl()");
    // The machine-generated lockfile body is dropped from the diff.
    expect(packet.text).not.toContain(pad(50));
    // The changed-file list still names every touched path.
    expect(packet.text).toContain("uv.lock");
    expect(packet.text).toContain("src/pipeline.py");
    expect(packet.stats.diffChars).toBeLessThan(
      DEFAULT_FRONTIER_LIMITS.maxDiffChars
    );
  });

  test("a mixed diff over 10x the cap is still reviewable, not refused", () => {
    // 600k lockfile chars is > 10x the 35k cap; before the fix this refused the
    // whole PR as unrepresentative even though only the lockfile was large.
    const packet = buildPacket({
      ...base,
      diff: lockfileSection + codeSection,
      files: [
        { additions: 2740, deletions: 0, path: "uv.lock", status: "modified" },
        {
          additions: 2,
          deletions: 0,
          path: "src/pipeline.py",
          status: "modified",
        },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.reason).toBeUndefined();
  });

  test("a lockfile-only oversized diff stays reviewable-empty, not refused", () => {
    const packet = buildPacket({
      ...base,
      diff: lockfileSection,
      files: [
        { additions: 2740, deletions: 0, path: "uv.lock", status: "modified" },
      ],
    });

    expect(packet.unsafe).toBe(false);
  });

  test("vendored XML schemas are low-value and excluded like lockfiles", () => {
    // A 1.2 MB vendored OOXML .xsd tree plus a small hand-written change must
    // be reviewable; the schema data carries no review signal on its own.
    const packet = buildPacket({
      ...base,
      diff: schemaSection + codeSection,
      files: [
        {
          additions: 2740,
          deletions: 0,
          path: "schemas/ISO-29500/dml-main.xsd",
          status: "added",
        },
        {
          additions: 2,
          deletions: 0,
          path: "src/pipeline.py",
          status: "modified",
        },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("def crawl()");
    expect(packet.text).not.toContain(pad(50));
    expect(packet.text).toContain("schemas/ISO-29500/dml-main.xsd");
    // The excluded blob must not inflate the measured diff.
    expect(packet.stats.diffChars).toBeLessThan(5_000);
  });

  test("a small hand-authored .xsd contract change stays reviewable", () => {
    // Size-gating, not a blanket exclusion: a deliberate schema edit is source
    // the reviewer must see, so it survives packet assembly.
    const smallXsd = `diff --git a/config/contract.xsd b/config/contract.xsd
index 5555555..6666666 100644
--- a/config/contract.xsd
+++ b/config/contract.xsd
@@ -1,1 +1,2 @@
+<xs:element name="maxRetries" type="xs:int"/>
`;
    const packet = buildPacket({
      ...base,
      diff: smallXsd + codeSection,
      files: [
        { additions: 1, deletions: 0, path: "config/contract.xsd", status: "modified" },
        { additions: 2, deletions: 0, path: "src/pipeline.py", status: "modified" },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.text).toContain("maxRetries");
  });

  test("a schema-blob-only PR is reviewable-empty with the file list kept", () => {
    // The deliberate boundary for vendored schema data: the packet is safe
    // (nothing refuses), carries no unreviewable diff body, and still names
    // every touched path so the operator sees a contract-shaped change
    // happened even though the blob itself was excluded.
    const packet = buildPacket({
      ...base,
      diff: schemaSection,
      files: [
        {
          additions: 2740,
          deletions: 0,
          path: "schemas/ISO-29500/dml-main.xsd",
          status: "added",
        },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.reason).toBeUndefined();
    expect(packet.text).toContain("schemas/ISO-29500/dml-main.xsd");
  });

  test("the 10x refusal still fires for an oversized non-excluded file", () => {
    // Exclusion must run before the cap check and only for eligible paths;
    // a giant runtime diff is refused exactly as before.
    const hugeTs = `diff --git a/src/pipeline.py b/src/pipeline.py
index aaaaaaa..bbbbbbb 100644
--- a/src/pipeline.py
+++ b/src/pipeline.py
@@ -1,1 +1,2 @@
${pad(600_000)}
`;
    const packet = buildPacket({
      ...base,
      diff: hugeTs,
      files: [
        { additions: 2740, deletions: 0, path: "src/pipeline.py", status: "modified" },
      ],
    });

    expect(packet.unsafe).toBe(true);
    expect(packet.reason).toContain("10x");
  });

  test("many low-value files do not trip the file-count ceiling", () => {
    // The sibling of the char cap: breadth in generated/asset paths must not
    // refuse a PR whose reviewable change is one small source file.
    const generated = Array.from({ length: 100 }, (_value, index) => ({
      additions: 1,
      deletions: 0,
      path: `generated/schema-${index}.ts`,
      status: "added" as const,
    }));
    const packet = buildPacket({
      ...base,
      diff: codeSection,
      files: [
        ...generated,
        {
          additions: 3,
          deletions: 0,
          path: "src/pipeline.py",
          status: "modified",
        },
      ],
    });

    expect(packet.unsafe).toBe(false);
    expect(packet.reason).toBeUndefined();
  });

  test("more than 80 reviewable files is still refused", () => {
    const packet = buildPacket({
      ...base,
      files: Array.from({ length: 90 }, (_value, index) => ({
        additions: 1,
        deletions: 0,
        path: `src/module-${index}.ts`,
        status: "modified" as const,
      })),
    });

    expect(packet.unsafe).toBe(true);
    expect(packet.reason).toContain("file ceiling");
  });

  test("an oversized non-lockfile diff is still refused", () => {
    const packet = buildPacket({
      ...base,
      diff: `diff --git a/src/big.py b/src/big.py
--- a/src/big.py
+++ b/src/big.py
${"+".padEnd(600_000, "x")}
`,
      files: [
        {
          additions: 600_000,
          deletions: 0,
          path: "src/big.py",
          status: "modified",
        },
      ],
    });

    expect(packet.unsafe).toBe(true);
    expect(packet.reason).toContain("raw diff");
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
