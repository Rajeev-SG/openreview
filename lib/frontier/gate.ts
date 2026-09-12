import { matchesGlob } from "node:path";

import type { FrontierRepoConfig } from "@/lib/frontier/config";
import type { GateDecision, GateReason } from "@/lib/frontier/types";

export interface GateChangedFile {
  additions: number;
  deletions: number;
  path: string;
  status: string;
}

export interface GateInput {
  config: FrontierRepoConfig;
  files: GateChangedFile[];
  forceReview?: boolean;
  labels?: string[];
}

interface Signal {
  detail: string;
  patterns: string[];
  signal: string;
  weight: number;
}

/**
 * Deterministic, observable review signals only. No semantic inference, no
 * LOC/file-count heuristics — those are exactly the ways the gate would either
 * spend frontier tokens on noise or skip work that a human would escalate.
 */
const REVIEW_SIGNALS: Signal[] = [
  {
    detail: "prompts / agent definitions / orchestration",
    patterns: [
      "**/AGENTS.md",
      "**/CLAUDE.md",
      ".agents/**",
      "**/agents/**",
      "**/prompts/**",
      "**/*.prompt.*",
      "**/prompt*/**",
      "**/skills/**",
      "**/SKILL.md",
      "**/orchestrat*",
      "**/personas/**",
      "**/system-prompt*",
    ],
    signal: "prompts_agents_orchestration",
    weight: 5,
  },
  {
    detail: "benchmark / evaluator / scorer / verifier logic",
    patterns: [
      "**/benchmark*/**",
      "**/bench*/**",
      "**/eval*/**",
      "**/scor*/**",
      "**/verif*/**",
      "**/rubric*",
      "**/*.eval.*",
      "**/harness/**",
      "**/*.grader.*",
    ],
    signal: "benchmark_evaluator_verifier",
    weight: 5,
  },
  {
    detail: "model / provider / routing / fallback / context policy",
    patterns: [
      "**/model*.ts",
      "**/model*.js",
      "**/models.y*ml",
      "**/provider*.ts",
      "**/provider*.js",
      "**/routing*",
      "**/router*",
      "**/fallback*",
      "**/context-policy*",
      "**/catalog*",
      "**/lib/model.ts",
    ],
    signal: "model_provider_routing_policy",
    weight: 5,
  },
  {
    detail: "auth / security / destructive operations",
    patterns: [
      "**/auth*.ts",
      "**/auth*.js",
      "**/auth/**",
      "**/*security*",
      "**/*secret*",
      "**/*credential*",
      "**/*permission*",
      "**/*rbac*",
      "**/*crypto*",
      "**/*sanitiz*",
    ],
    signal: "auth_security_destructive",
    weight: 6,
  },
  {
    detail: "CI / release / deployment gates",
    patterns: [
      ".github/workflows/**",
      ".github/actions/**",
      "**/ci/**",
      "**/release*",
      "**/deploy*/**",
      "Dockerfile",
      "**/*.tf",
      "vercel.json",
    ],
    signal: "ci_release_deployment",
    weight: 4,
  },
  {
    detail: "persistence / migrations / concurrency / queues",
    patterns: [
      "**/migrations/**",
      "**/*migration*",
      "**/db/**",
      "**/*schema*",
      "**/*queue*",
      "**/*worker*",
      "**/*concurren*",
      "**/*transaction*",
      "**/store*.ts",
    ],
    signal: "persistence_migrations_concurrency",
    weight: 4,
  },
  {
    detail: "external API / schema / webhook contracts",
    patterns: [
      "**/webhooks/**",
      "**/api/**",
      "**/*contract*",
      "**/openapi*",
      "**/*.proto",
      "**/graphql/**",
    ],
    signal: "external_contract",
    weight: 4,
  },
  {
    detail: "requirements / specs / operator instructions",
    patterns: [
      "**/specs/**",
      "**/requirements/**",
      "**/prd/**",
      "**/rfcs/**",
      "**/adr/**",
      "**/*.spec.md",
      "**/instructions*",
    ],
    signal: "requirements_specs_instructions",
    weight: 4,
  },
  {
    detail: "dependency manifests / major runtime dependency changes",
    patterns: [
      "package.json",
      "**/package.json",
      "pyproject.toml",
      "requirements.txt",
      "go.mod",
      "Cargo.toml",
      "Gemfile",
      "composer.json",
      "**/dependencies*",
    ],
    signal: "dependency_manifest",
    weight: 3,
  },
];

/**
 * Files that are genuinely low-value on their own. `docs/**` and `specs/**`
 * are deliberately *not* here: requirement and spec documents materially change
 * behaviour and must be reviewed.
 */
const LOW_VALUE_PATTERNS = [
  "**/*.mdx",
  "**/*.md",
  "LICENSE*",
  "CHANGELOG*",
  "**/*.txt",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.ico",
  "**/*.webp",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.mp4",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "dist/**",
  ".next/**",
  "generated/**",
  "**/*.generated.*",
];

/** Material documents that override the ordinary-docs skip. */
const MATERIAL_DOC_PATTERNS = [
  "**/specs/**",
  "**/spec/**",
  "**/requirements/**",
  "**/prd/**",
  "**/rfcs/**",
  "**/adr/**",
  "**/*.spec.md",
  "**/instructions*",
];

const RUNTIME_PATTERNS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mts",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.rb",
  "**/*.cs",
];

const TEST_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

const safeMatches = (path: string, pattern: string): boolean => {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return false;
  }
};

const matchesAny = (path: string, patterns: string[]): boolean =>
  patterns.some((pattern) => safeMatches(path, pattern));

const isLowValue = (path: string): boolean =>
  matchesAny(path, LOW_VALUE_PATTERNS) &&
  !matchesAny(path, MATERIAL_DOC_PATTERNS);

/**
 * Evaluate the deterministic gate. Returns a decision plus the human-readable
 * reasons that justify it (persisted for audit and posted to the check run).
 */
export const evaluateGate = (input: GateInput): GateDecision => {
  const { config, files } = input;
  const labels = input.labels ?? [];
  const { threshold } = config;

  const base: Pick<GateDecision, "reasons" | "score" | "threshold"> = {
    reasons: [],
    score: 0,
    threshold,
  };

  if (!config.enabled) {
    return { ...base, mode: "skip", overridden: "force_skip" };
  }

  if (files.length === 0) {
    return { ...base, mode: "skip", overridden: "force_skip" };
  }

  if (files.every((file) => matchesAny(file.path, config.neverReview))) {
    return {
      ...base,
      mode: "skip",
      overridden: "never_review",
      reasons: [
        {
          detail: "all changed files match never_review rules",
          signal: "never_review",
          weight: 0,
        },
      ],
    };
  }

  if (input.forceReview || labels.includes("frontier-review")) {
    return {
      ...base,
      mode: "review",
      overridden: "label",
      reasons: [
        {
          detail: "manual frontier-review override",
          signal: "manual_override",
          weight: 0,
        },
      ],
    };
  }

  const alwaysMatched = files.filter((file) =>
    matchesAny(file.path, config.alwaysReview)
  );

  if (alwaysMatched.length > 0) {
    return {
      ...base,
      mode: "review",
      overridden: "always_review",
      reasons: alwaysMatched.map((file) => ({
        detail: file.path,
        signal: "always_review",
        weight: 10,
      })),
      score: 10,
    };
  }

  // Pure docs / assets / lockfiles / generated output: zero frontier tokens.
  const allLowValue = files.every((file) => isLowValue(file.path));

  if (allLowValue) {
    return {
      ...base,
      mode: "skip",
      overridden: "force_skip",
      reasons: [
        {
          detail: "only docs/assets/lockfiles/generated files changed",
          signal: "low_value_only",
          weight: 0,
        },
      ],
    };
  }

  const reasons: GateReason[] = [];

  for (const signal of REVIEW_SIGNALS) {
    const matched = files.filter((file) =>
      matchesAny(file.path, signal.patterns)
    );

    if (matched.length > 0) {
      reasons.push({
        detail: `${signal.detail}: ${matched
          .slice(0, 5)
          .map((file) => file.path)
          .join(", ")}`,
        signal: signal.signal,
        weight: signal.weight,
      });
    }
  }

  const runtimeFiles = files.filter((file) =>
    matchesAny(file.path, RUNTIME_PATTERNS)
  );
  const testFiles = files.filter((file) =>
    matchesAny(file.path, TEST_PATTERNS)
  );
  const runtimeWithoutTests = runtimeFiles.filter(
    (file) => !matchesAny(file.path, TEST_PATTERNS) && !isLowValue(file.path)
  );

  if (runtimeWithoutTests.length > 0 && testFiles.length === 0) {
    reasons.push({
      detail: `runtime changes without corresponding tests: ${runtimeWithoutTests
        .slice(0, 5)
        .map((file) => file.path)
        .join(", ")}`,
      signal: "runtime_without_tests",
      weight: 5,
    });
  }

  const score = reasons.reduce((total, reason) => total + reason.weight, 0);

  return {
    mode: score >= threshold ? "review" : "skip",
    reasons,
    score,
    threshold,
  };
};

export const gateSummary = (decision: GateDecision): string => {
  const header =
    decision.mode === "review"
      ? `Review requested (score ${decision.score} >= threshold ${decision.threshold})`
      : `Skipped (score ${decision.score} < threshold ${decision.threshold})`;

  if (decision.reasons.length === 0) {
    return header;
  }

  return `${header}\n\n${decision.reasons
    .map((reason) => `- ${reason.detail}`)
    .join("\n")}`;
};
