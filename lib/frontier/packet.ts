import { createHash } from "node:crypto";

import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  FrontierFinding,
  FrontierLimits,
  GateReason,
} from "@/lib/frontier/types";

export interface PacketContextFile {
  content: string;
  path: string;
}

export interface PacketInput {
  baseSha: string;
  body: string;
  ciEvidence: string[];
  contextFiles: PacketContextFile[];
  delta?: {
    fromSha: string;
    originalFindings: FrontierFinding[];
  };
  diff: string;
  files: GateChangedFile[];
  gateReasons: GateReason[];
  headSha: string;
  limits: FrontierLimits;
  linkedIssue: { body: string; number: number; title: string } | null;
  prNumber: number;
  repo: string;
  title: string;
}

export interface Packet {
  hash: string;
  reason?: string;
  stats: {
    contextFiles: number;
    diffChars: number;
    totalChars: number;
    truncated: boolean;
  };
  text: string;
  unsafe: boolean;
}

/**
 * Ceiling on "obviously unrepresentative" packets. A bounded diff slice plus a
 * complete changed-file list is still useful, so ordinary large PRs are
 * reviewed with an explicit truncation banner. Only a diff this many times
 * larger than the cap (or an unwieldy file count) is refused outright.
 */
const UNSAFE_DIFF_RATIO = 10;
const MAX_PACKET_FILES = 80;

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { label: "openrouter-key", pattern: /\bsk-or-[A-Za-z0-9_-]{8,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    label: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    label: "assigned-secret",
    pattern:
      /(?<=(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?)[^\s"',]{12,}/gi,
  },
];

export const redactSecrets = (
  input: string
): { redacted: boolean; text: string } => {
  let text = input;
  let redacted = false;

  for (const entry of SECRET_PATTERNS) {
    const before = text;
    text = text.replace(entry.pattern, `[REDACTED:${entry.label}]`);
    redacted = redacted || text !== before;
  }

  return { redacted, text };
};

interface Clipped {
  text: string;
  truncated: boolean;
}

const truncate = (value: string, max: number): Clipped =>
  value.length <= max
    ? { text: value, truncated: false }
    : {
        text: `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`,
        truncated: true,
      };

const hashPacket = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 40);

const renderFinding = (finding: FrontierFinding): string =>
  [
    `- [${finding.severity}] ${finding.id} (${finding.category})`,
    finding.path
      ? `  - location: \`${finding.path}\`${finding.line ? `:${finding.line}` : ""}`
      : "",
    `  - problem: ${finding.problem}`,
    `  - impact: ${finding.impact}`,
    `  - required_fix: ${finding.required_fix}`,
    `  - verification: ${finding.verification}`,
  ]
    .filter(Boolean)
    .join("\n");

const clipContext = (
  files: PacketContextFile[],
  limits: FrontierLimits
): { files: { path: string; text: string }[]; truncated: boolean } => {
  const clipped = files.slice(0, limits.maxContextFiles).map((file) => {
    const value = truncate(file.content, limits.maxContextPerFileChars);
    return { path: file.path, text: value.text, truncated: value.truncated };
  });

  return {
    files: clipped.map(({ path, text }) => ({ path, text })),
    truncated: clipped.some((file) => file.truncated),
  };
};

const headerSections = (
  input: PacketInput,
  bodyText: string,
  issueText: string
): string[] => {
  const sections = [
    "# Frontier quality review request",
    "",
    `Repo: ${input.repo}`,
    `PR: #${input.prNumber} — ${input.title}`,
    `Base SHA: ${input.baseSha}`,
    `Head SHA: ${input.headSha}`,
    "",
    "## PR description",
    bodyText || "(empty)",
  ];

  if (input.linkedIssue) {
    sections.push(
      "",
      `## Linked issue #${input.linkedIssue.number} — ${input.linkedIssue.title}`,
      issueText || "(empty)"
    );
  }

  return sections;
};

const TRUNCATION_BANNER =
  "> NOTE: the diff below is truncated. The changed-file list is complete; " +
  "judge from the listed files, the evidence and the implementation shown.";

const changeSections = (
  input: PacketInput,
  diffText: string,
  truncated: boolean
): string[] => [
  "",
  "## Changed files",
  ...input.files.map(
    (file) =>
      `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`
  ),
  "",
  "## Diff",
  ...(truncated ? [TRUNCATION_BANNER, ""] : []),
  "```diff",
  diffText || "(empty)",
  "```",
];

const deltaSections = (
  input: PacketInput,
  diffText: string,
  truncated: boolean
): string[] => {
  const { delta } = input;

  if (!delta) {
    return [];
  }

  return [
    "",
    "## Delta review (#2)",
    "This is the final, delta-only review of the repair pass.",
    `Original review SHA: ${delta.fromSha}`,
    `Current head SHA: ${input.headSha}`,
    "",
    "### Findings raised in review #1",
    ...delta.originalFindings.map(renderFinding),
    "",
    `### Delta diff (${delta.fromSha.slice(0, 8)}..${input.headSha.slice(0, 8)})`,
    ...(truncated ? [TRUNCATION_BANNER, ""] : []),
    "```diff",
    diffText,
    "```",
  ];
};

const tailSections = (input: PacketInput): string[] => [
  "",
  "## Gate reasons",
  ...(input.gateReasons.length > 0
    ? input.gateReasons.map((reason) => `- ${reason.detail}`)
    : ["- (none)"]),
  "",
  "## CI / test evidence",
  ...(input.ciEvidence.length > 0
    ? input.ciEvidence.map((line) => `- ${line}`)
    : ["- (no evidence supplied)"]),
  "",
  "## Instructions",
  "Judge the whole solution, not just the diff: requirement fit, architecture,",
  "correctness, integration, reliability, security/blast radius, cost/latency,",
  "verification quality and simplicity.",
  "Report at most 5 materially consequential findings. No style nits, praise or",
  "refactor wish-lists. A clean implementation of the wrong solution must fail.",
];

const contextSections = (files: { path: string; text: string }[]): string[] => {
  if (files.length === 0) {
    return [];
  }

  const sections = ["", "## Local context"];

  for (const file of files) {
    sections.push("", `### ${file.path}`, "```", file.text || "(empty)", "```");
  }

  return sections;
};

const collectUnsafeReasons = (input: PacketInput): string[] => {
  const reasons: string[] = [];

  if (input.diff.length > input.limits.maxDiffChars * UNSAFE_DIFF_RATIO) {
    reasons.push(
      `raw diff is ${input.diff.length} chars, >${UNSAFE_DIFF_RATIO}x the ${input.limits.maxDiffChars} cap`
    );
  }

  if (input.files.length > MAX_PACKET_FILES) {
    reasons.push(
      `${input.files.length} changed files exceeds the ${MAX_PACKET_FILES} file ceiling`
    );
  }

  return reasons;
};

/**
 * Build a bounded review packet: intent + interfaces + evidence + changed
 * implementation, never a raw source dump. The total packet cap is enforced by
 * dropping local context first.
 */
export const buildPacket = (input: PacketInput): Packet => {
  const unsafeReasons = collectUnsafeReasons(input);

  const body = truncate(input.body, input.limits.maxPrBodyChars);
  const issue = truncate(
    input.linkedIssue?.body ?? "",
    input.limits.maxLinkedIssueChars
  );
  const diff = truncate(input.diff, input.limits.maxDiffChars);
  const context = clipContext(input.contextFiles, input.limits);

  const head = [
    ...headerSections(input, body.text, issue.text),
    ...(input.delta
      ? deltaSections(input, diff.text, diff.truncated)
      : changeSections(input, diff.text, diff.truncated)),
    ...tailSections(input),
  ];

  const withContext = [...head, ...contextSections(context.files)];

  let { text } = redactSecrets(withContext.join("\n"));

  if (text.length > input.limits.maxPacketChars && context.files.length > 0) {
    ({ text } = redactSecrets(head.join("\n")));
  }

  if (text.length > input.limits.maxPacketChars) {
    ({ text } = truncate(text, input.limits.maxPacketChars));
    unsafeReasons.push(
      `packet exceeded ${input.limits.maxPacketChars} chars even after trimming context`
    );
  }

  return {
    hash: hashPacket(text),
    reason: unsafeReasons.length > 0 ? unsafeReasons.join("; ") : undefined,
    stats: {
      contextFiles: context.files.length,
      diffChars: Math.min(input.diff.length, input.limits.maxDiffChars),
      totalChars: text.length,
      truncated:
        body.truncated ||
        issue.truncated ||
        diff.truncated ||
        context.truncated ||
        input.diff.length > input.limits.maxDiffChars,
    },
    text,
    unsafe: unsafeReasons.length > 0,
  };
};

const renderFindingsMarkdownInternal = (findings: FrontierFinding[]): string =>
  findings
    .map(
      (finding) =>
        `#### [${finding.severity}] ${finding.id} — ${finding.category}\n\n` +
        `${finding.path ? `\`${finding.path}\`${finding.line ? `:${finding.line}` : ""}\n\n` : ""}` +
        `**Problem:** ${finding.problem}\n\n` +
        `**Impact:** ${finding.impact}\n\n` +
        `**Required fix:** ${finding.required_fix}\n\n` +
        `**Verification:** ${finding.verification}`
    )
    .join("\n\n");

export const renderFindingsMarkdown = (findings: FrontierFinding[]): string =>
  findings.length === 0
    ? "_No material findings._"
    : renderFindingsMarkdownInternal(findings);
