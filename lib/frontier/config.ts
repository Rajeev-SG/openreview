import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  FrontierBudgetLimits,
  FrontierLimits,
} from "@/lib/frontier/types";

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_FRONTIER_LIMITS: FrontierLimits = {
  maxContextFiles: 6,
  maxContextPerFileChars: 4000,
  maxDiffChars: 35_000,
  maxLinkedIssueChars: 5000,
  maxOutputTokens: 3000,
  maxPacketChars: 50_000,
  maxPrBodyChars: 4000,
  maxReviewsPerCycle: 2,
};

const DEFAULT_DAILY_BUDGET_USD = 5;
const DEFAULT_MONTHLY_BUDGET_USD = 50;

const readNumber = (
  raw: string | undefined,
  fallback: number,
  { min }: { min: number }
): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `Invalid frontier limit "${raw}": expected a number >= ${min}.`
    );
  }

  return value;
};

/**
 * Hard caps. The two-review invariant is not configurable away: raising
 * `FRONTIER_MAX_REVIEWS_PER_CYCLE` above 2 would break the V1 contract, so any
 * value above 2 is clamped and reported.
 */
export const readFrontierLimits = (
  source: EnvLike = process.env
): FrontierLimits => {
  const configuredMaxReviews = readNumber(
    source.FRONTIER_MAX_REVIEWS_PER_CYCLE,
    DEFAULT_FRONTIER_LIMITS.maxReviewsPerCycle,
    { min: 1 }
  );

  return {
    maxContextFiles: readNumber(
      source.FRONTIER_MAX_CONTEXT_FILES,
      DEFAULT_FRONTIER_LIMITS.maxContextFiles,
      { min: 0 }
    ),
    maxContextPerFileChars: readNumber(
      source.FRONTIER_MAX_CONTEXT_PER_FILE_CHARS,
      DEFAULT_FRONTIER_LIMITS.maxContextPerFileChars,
      { min: 0 }
    ),
    maxDiffChars: readNumber(
      source.FRONTIER_MAX_DIFF_CHARS,
      DEFAULT_FRONTIER_LIMITS.maxDiffChars,
      { min: 0 }
    ),
    maxLinkedIssueChars: readNumber(
      source.FRONTIER_MAX_LINKED_ISSUE_CHARS,
      DEFAULT_FRONTIER_LIMITS.maxLinkedIssueChars,
      { min: 0 }
    ),
    maxOutputTokens: readNumber(
      source.FRONTIER_MAX_OUTPUT_TOKENS,
      DEFAULT_FRONTIER_LIMITS.maxOutputTokens,
      { min: 1 }
    ),
    maxPacketChars: readNumber(
      source.FRONTIER_MAX_PACKET_CHARS,
      DEFAULT_FRONTIER_LIMITS.maxPacketChars,
      { min: 1 }
    ),
    maxPrBodyChars: readNumber(
      source.FRONTIER_MAX_PR_BODY_CHARS,
      DEFAULT_FRONTIER_LIMITS.maxPrBodyChars,
      { min: 0 }
    ),
    maxReviewsPerCycle: Math.min(configuredMaxReviews, 2),
  };
};

/**
 * Budgets must be explicit: if an operator has not set a ceiling we fall back
 * to a conservative default rather than spending unbounded. A budget of 0 means
 * "never spend", which fails closed.
 */
export const readFrontierBudget = (
  source: EnvLike = process.env
): FrontierBudgetLimits => ({
  dailyUsd: readNumber(
    source.FRONTIER_DAILY_BUDGET_USD,
    DEFAULT_DAILY_BUDGET_USD,
    { min: 0 }
  ),
  monthlyUsd: readNumber(
    source.FRONTIER_MONTHLY_BUDGET_USD,
    DEFAULT_MONTHLY_BUDGET_USD,
    { min: 0 }
  ),
});

export const FRONTIER_MODEL = "openai/gpt-6-astra";
export const FRONTIER_REASONING_EFFORT = "low";

export const readFrontierModel = (source: EnvLike = process.env): string => {
  const raw = source.FRONTIER_MODEL?.trim();
  return raw && raw.length > 0 ? raw : FRONTIER_MODEL;
};

export const isFrontierEnabled = (source: EnvLike = process.env): boolean => {
  const raw = source.FRONTIER_ENABLED?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
};

const repoConfigSchema = z
  .object({
    always_review: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    never_review: z.array(z.string()).optional(),
    threshold: z.number().optional(),
  })
  .partial();

export interface FrontierRepoConfig {
  alwaysReview: string[];
  enabled: boolean;
  neverReview: string[];
  threshold: number;
}

export const DEFAULT_REPO_CONFIG: FrontierRepoConfig = {
  alwaysReview: [],
  enabled: true,
  neverReview: [],
  threshold: 5,
};

/**
 * Parse the optional per-repo `frontier:` block. Supports YAML or JSON and
 * accepts either a bare mapping or a `{ frontier: {...} }` wrapper. Malformed
 * config is ignored (defaults win) rather than crashing the webhook path.
 */
export const parseRepoConfig = (
  raw: string | null | undefined
): FrontierRepoConfig => {
  if (!raw || raw.trim() === "") {
    return DEFAULT_REPO_CONFIG;
  }

  let document: unknown;

  try {
    document = parseYaml(raw);
  } catch {
    return DEFAULT_REPO_CONFIG;
  }

  const root =
    document && typeof document === "object"
      ? (document as Record<string, unknown>)
      : {};

  const candidate =
    root.frontier && typeof root.frontier === "object" ? root.frontier : root;

  const parsed = repoConfigSchema.safeParse(candidate);

  if (!parsed.success) {
    return DEFAULT_REPO_CONFIG;
  }

  return {
    alwaysReview: parsed.data.always_review ?? [],
    enabled: parsed.data.enabled ?? true,
    neverReview: parsed.data.never_review ?? [],
    threshold: parsed.data.threshold ?? DEFAULT_REPO_CONFIG.threshold,
  };
};
