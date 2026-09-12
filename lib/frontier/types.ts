/**
 * Shared types for the bounded frontier quality gate (issue #30 / #29).
 *
 * The gate is a *judge*, not a coding agent: one direct structured OpenRouter
 * call, at most twice per review cycle.
 */

export const FRONTIER_CHECK_NAME = "frontier-quality";
export const FINAL_SIGNAL_LABEL = "frontier-ready-final";
export const NEW_CYCLE_LABEL = "frontier-new-cycle";
export const FORCE_REVIEW_LABEL = "frontier-review";

export type FrontierSeverity = "P0" | "P1" | "P2" | "P3";

export interface FrontierFinding {
  category: string;
  id: string;
  impact: string;
  line?: number;
  path?: string;
  problem: string;
  required_fix: string;
  severity: FrontierSeverity;
  verification: string;
}

export interface FrontierReview {
  findings: FrontierFinding[];
  summary: string;
  verdict: "pass" | "changes_required";
}

export interface ModelUsage {
  costUsd: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
}

export type FrontierLifecycle =
  | "idle"
  | "skipped"
  | "ci_failed"
  | "waiting_ci"
  | "reviewing"
  | "waiting_final_signal"
  | "passed"
  | "blocked"
  | "needs_manual_review"
  | "budget_exhausted";

export type GateMode = "review" | "skip";

export interface GateReason {
  detail: string;
  signal: string;
  weight: number;
}

export interface GateDecision {
  mode: GateMode;
  overridden?: "always_review" | "never_review" | "label" | "force_skip";
  reasons: GateReason[];
  score: number;
  threshold: number;
}

export interface FrontierReviewRecord {
  createdAt: string;
  findings: FrontierFinding[];
  packetHash: string;
  reviewNumber: 1 | 2;
  reviewedSha: string;
  usage: ModelUsage;
  verdict: "pass" | "changes_required";
}

export interface FrontierPrState {
  baselineSha?: string;
  checkRunId?: number;
  cycleId: number;
  findings?: FrontierFinding[];
  finalReviewSha?: string;
  finalSignalPending?: boolean;
  gate?: GateDecision;
  headSha: string;
  initialReviewSha?: string;
  lifecycle: FrontierLifecycle;
  packetHashes: string[];
  prNumber: number;
  repo: string;
  reviewCount: number;
  reviews: FrontierReviewRecord[];
  updatedAt: string;
  version: 1;
}

export interface FrontierLimits {
  maxContextFiles: number;
  maxContextPerFileChars: number;
  maxDiffChars: number;
  maxLinkedIssueChars: number;
  maxOutputTokens: number;
  maxPacketChars: number;
  maxPrBodyChars: number;
  maxReviewsPerCycle: number;
}

export interface FrontierBudgetLimits {
  dailyUsd: number;
  inputUsdPerMTok: number;
  maxCallUsd: number;
  monthlyUsd: number;
  outputUsdPerMTok: number;
}

export interface FrontierSpendEntry {
  costUsd: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  prNumber: number;
  repo: string;
  reviewNumber: number;
  timestamp: string;
}

export interface FrontierSpendLedger {
  calls: number;
  costUsd: number;
}
