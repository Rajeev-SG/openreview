import {
  describeSpend,
  reconcileBudget,
  reserveBudget,
} from "@/lib/frontier/budget";
import { parseRepoConfig } from "@/lib/frontier/config";
import { evaluateGate, gateSummary } from "@/lib/frontier/gate";
import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  CheckRunView,
  FrontierCheckUpdate,
  FrontierGitHub,
} from "@/lib/frontier/github";
import { FRONTIER_SYSTEM_PROMPT } from "@/lib/frontier/model";
import type { FrontierModelClient } from "@/lib/frontier/model";
import { buildPacket, renderFindingsMarkdown } from "@/lib/frontier/packet";
import type { PacketContextFile } from "@/lib/frontier/packet";
import {
  createInitialState,
  deliveryKey,
  IDEMPOTENCY_TTL_MS,
  idempotencyKey,
  loadPrState,
  savePrState,
} from "@/lib/frontier/store";
import type { FrontierKv } from "@/lib/frontier/store";
import {
  FINAL_SIGNAL_LABEL,
  FORCE_REVIEW_LABEL,
  FRONTIER_CHECK_NAME,
  NEW_CYCLE_LABEL,
} from "@/lib/frontier/types";
import type {
  FrontierBudgetLimits,
  FrontierFinding,
  FrontierLimits,
  FrontierPrState,
  FrontierReview,
} from "@/lib/frontier/types";

export interface FrontierEngineDeps {
  budget: FrontierBudgetLimits;
  github: FrontierGitHub;
  kv: FrontierKv;
  limits: FrontierLimits;
  log?: (event: string, meta?: Record<string, unknown>) => void;
  model: FrontierModelClient;
  now?: () => Date;
}

export interface FrontierEvent {
  action: string;
  deliveryId?: string;
  headSha?: string;
  kind: "check_run" | "label" | "pull_request";
  label?: string;
  prNumber: number;
  repo: string;
}

export interface FrontierOutcome {
  calls: number;
  costUsd: number;
  cycleId: number;
  detail?: string;
  reviewCount: number;
  status: string;
}

const CONTEXT_PRIORITY_PATTERNS = [
  "**/types.ts",
  "**/types/**",
  "**/*.d.ts",
  "**/schema*",
  "**/config.ts",
  "**/index.ts",
  "**/env.ts",
];

const RUNTIME_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".py",
  ".go",
  ".rs",
];

const FAILING_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "timed_out",
]);

const TERMINAL_LIFECYCLES = new Set(["passed", "blocked"]);

const nowOf = (deps: FrontierEngineDeps): Date => deps.now?.() ?? new Date();

/**
 * Await boundary for branches that resolve without I/O. Keeps the async
 * contract of the return type explicit without inventing fake work.
 */
const settled = async <T>(value: T): Promise<T> => {
  await Promise.resolve();
  return value;
};

const emit = (
  deps: FrontierEngineDeps,
  event: string,
  meta?: Record<string, unknown>
): void => {
  deps.log?.(event, meta);
};

const relative = (path: string, pattern: string): boolean => {
  const suffix = pattern.replace(/^\*\*\//, "");
  return path.endsWith(suffix.replace(/^\*/, ""));
};

const contextCandidates = (
  files: GateChangedFile[],
  limits: FrontierLimits
): string[] => {
  const runtime = files.filter((file) =>
    RUNTIME_EXTENSIONS.some((extension) => file.path.endsWith(extension))
  );

  const priority = runtime.filter((file) =>
    CONTEXT_PRIORITY_PATTERNS.some((pattern) => relative(file.path, pattern))
  );

  const seen = new Set<string>();
  const picked: string[] = [];

  for (const file of [...priority, ...runtime]) {
    if (seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    picked.push(file.path);
    if (picked.length >= limits.maxContextFiles) {
      break;
    }
  }

  return picked;
};

interface CiStatus {
  evidence: string[];
  failed: CheckRunView[];
  ok: boolean;
  pending: string[];
  required: string[];
}

const resolveCi = async (
  deps: FrontierEngineDeps,
  repo: string,
  baseBranch: string,
  ref: string
): Promise<CiStatus> => {
  const required = await deps.github.getRequiredChecks(repo, baseBranch, ref);
  const runs = await deps.github.listCheckRuns(repo, ref);

  const requiredRuns = runs.filter((run) => required.includes(run.name));
  const failed = requiredRuns.filter(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== null &&
      FAILING_CONCLUSIONS.has(run.conclusion)
  );
  const pending = required.filter(
    (name) =>
      !requiredRuns.some(
        (run) => run.name === name && run.status === "completed"
      )
  );

  const evidence = requiredRuns.map(
    (run) => `${run.name}: ${run.conclusion ?? run.status}`
  );

  return {
    evidence,
    failed,
    ok: failed.length === 0 && pending.length === 0,
    pending,
    required,
  };
};

const setCheck = async (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  update: Partial<FrontierCheckUpdate> & {
    status: FrontierCheckUpdate["status"];
    summary: string;
    title: string;
  }
): Promise<void> => {
  const id = await deps.github.setFrontierCheck({
    ...update,
    headSha: state.headSha,
    name: FRONTIER_CHECK_NAME,
    prNumber: state.prNumber,
    repo: state.repo,
  });
  state.checkRunId = id;
};

const buildContextFiles = async (
  deps: FrontierEngineDeps,
  repo: string,
  files: GateChangedFile[],
  ref: string,
  limits: FrontierLimits
): Promise<PacketContextFile[]> => {
  const paths = contextCandidates(files, limits);
  const result: PacketContextFile[] = [];

  for (const path of paths) {
    try {
      const content = await deps.github.getFileContent(repo, path, ref);
      if (content !== null) {
        result.push({ content, path });
      }
    } catch {
      // Context is best-effort; a missing file must not block the review.
    }
  }

  return result;
};

const findingsJson = (findings: FrontierFinding[]): string =>
  `\n\n<details><summary>Machine-readable findings</summary>\n\n\`\`\`json\n${JSON.stringify(
    findings,
    null,
    2
  )}\n\`\`\`\n\n</details>`;

const blockingFindings = (findings: FrontierFinding[]): FrontierFinding[] =>
  findings.filter((finding) => finding.severity !== "P3");

const recordReview = (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  input: {
    findings: FrontierFinding[];
    packetHash: string;
    review: FrontierReview;
    reviewNumber: 1 | 2;
    reviewedSha: string;
    usage: {
      costUsd: number;
      inputTokens: number;
      model: string;
      outputTokens: number;
    };
  },
  now: Date
): void => {
  state.reviews.push({
    createdAt: now.toISOString(),
    findings: input.findings,
    packetHash: input.packetHash,
    reviewNumber: input.reviewNumber,
    reviewedSha: input.reviewedSha,
    usage: input.usage,
    verdict: input.review.verdict,
  });
  state.packetHashes.push(input.packetHash);
  state.reviewCount = input.reviewNumber;

  emit(deps, "frontier.spend", {
    cycleId: state.cycleId,
    prNumber: state.prNumber,
    repo: state.repo,
    ...describeSpend({
      costUsd: input.usage.costUsd,
      inputTokens: input.usage.inputTokens,
      model: input.usage.model,
      outputTokens: input.usage.outputTokens,
      prNumber: state.prNumber,
      repo: state.repo,
      reviewNumber: input.reviewNumber,
      timestamp: now.toISOString(),
    }),
  });
};

const reviewSummaryComment = (review: FrontierReview): string =>
  [
    "## Frontier review",
    "",
    review.summary || "_No summary provided._",
    "",
    renderFindingsMarkdown(review.findings),
    "",
    "---",
    "",
    "Push your fixes, wait for required CI to go green, then add the `frontier-ready-final` label to request the single delta review. Repair pushes on their own never trigger another paid review.",
  ].join("\n");

const runFirstReview = async (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  options: { forceReview?: boolean },
  now: Date
): Promise<FrontierOutcome> => {
  const pr = await deps.github.getPullRequest(state.repo, state.prNumber);
  state.headSha = pr.headSha;

  const files = await deps.github.getChangedFiles(state.repo, state.prNumber);
  const repoConfig = parseRepoConfig(
    await deps.github.getRepoConfig(state.repo, pr.headSha)
  );
  const gate = evaluateGate({
    config: repoConfig,
    files,
    forceReview: options.forceReview,
    labels: pr.labels,
  });
  state.gate = gate;

  emit(deps, "frontier.gate", {
    cycleId: state.cycleId,
    mode: gate.mode,
    prNumber: state.prNumber,
    repo: state.repo,
    score: gate.score,
  });

  if (gate.mode === "skip") {
    state.lifecycle = "skipped";
    await setCheck(deps, state, {
      conclusion: "success",
      status: "completed",
      summary: gateSummary(gate),
      title: "Frontier review not required",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "gate skipped",
      reviewCount: state.reviewCount,
      status: "skipped",
    };
  }

  const ci = await resolveCi(deps, state.repo, pr.baseBranch, pr.headSha);

  if (!ci.ok) {
    if (ci.failed.length > 0) {
      state.lifecycle = "ci_failed";
      await setCheck(deps, state, {
        conclusion: "neutral",
        status: "completed",
        summary: `Required CI is failing: ${ci.failed
          .map((run) => `${run.name} (${run.conclusion})`)
          .join(", ")}. No frontier tokens were spent.`,
        title: "Frontier review skipped: required CI failed",
      });
      return {
        calls: 0,
        costUsd: 0,
        cycleId: state.cycleId,
        detail: "required CI failed",
        reviewCount: state.reviewCount,
        status: "ci_failed",
      };
    }

    state.lifecycle = "waiting_ci";
    await setCheck(deps, state, {
      status: "in_progress",
      summary: `Waiting for required checks: ${ci.pending.join(", ") || "unknown"}`,
      title: "Frontier review waiting for required CI",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "required CI pending",
      reviewCount: state.reviewCount,
      status: "waiting_ci",
    };
  }

  const issue = await deps.github.getLinkedIssue(state.repo, state.prNumber);
  const diff = await deps.github.getDiff(state.repo, state.prNumber);
  const contextFiles = await buildContextFiles(
    deps,
    state.repo,
    files,
    pr.headSha,
    deps.limits
  );

  const packet = buildPacket({
    baseSha: pr.baseSha,
    body: pr.body,
    ciEvidence: ci.evidence,
    contextFiles,
    diff,
    files,
    gateReasons: gate.reasons,
    headSha: pr.headSha,
    limits: deps.limits,
    linkedIssue: issue,
    prNumber: state.prNumber,
    repo: state.repo,
    title: pr.title,
  });

  if (packet.unsafe) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Packet could not be built safely: ${packet.reason}`,
      title: "Frontier review needs manual review",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: packet.reason,
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  const key = idempotencyKey({
    cycleId: state.cycleId,
    packetHash: packet.hash,
    prNumber: state.prNumber,
    repo: state.repo,
    reviewNumber: 1,
    reviewedSha: pr.headSha,
  });

  if (await deps.kv.get(key)) {
    emit(deps, "frontier.idempotent_hit", { reviewNumber: 1 });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "review #1 already paid for this packet",
      reviewCount: state.reviewCount,
      status: "already_reviewed",
    };
  }

  const budget = await reserveBudget(
    deps.kv,
    now,
    deps.budget,
    deps.budget.maxCallUsd
  );
  if (!budget.allowed) {
    state.lifecycle = "budget_exhausted";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Frontier review skipped: ${budget.reason}. No fallback model is used.`,
      title: "Frontier review skipped: budget exhausted",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: `budget: ${budget.reason}`,
      reviewCount: state.reviewCount,
      status: "budget_exhausted",
    };
  }

  await setCheck(deps, state, {
    status: "in_progress",
    summary: "Frontier review #1 running",
    title: "Frontier review #1 running",
  });

  let response;
  try {
    response = await deps.model.review({
      maxTokens: deps.limits.maxOutputTokens,
      system: FRONTIER_SYSTEM_PROMPT,
      user: packet.text,
    });
  } catch (error) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Frontier review #1 failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      title: "Frontier review failed",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "model call failed",
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  await deps.kv.set(key, 1, IDEMPOTENCY_TTL_MS);
  // Replace the reservation with the real billed cost.
  await reconcileBudget(
    deps.kv,
    now,
    deps.budget.maxCallUsd,
    response.usage.costUsd
  );

  state.initialReviewSha = pr.headSha;
  state.findings = response.review.findings;

  if (response.review.verdict === "pass") {
    state.lifecycle = "passed";
    recordReview(
      deps,
      state,
      {
        findings: response.review.findings,
        packetHash: packet.hash,
        review: response.review,
        reviewNumber: 1,
        reviewedSha: pr.headSha,
        usage: response.usage,
      },
      now
    );
    await setCheck(deps, state, {
      conclusion: "success",
      status: "completed",
      summary: response.review.summary || "Frontier review passed.",
      title: "Frontier review passed",
    });
    return {
      calls: 1,
      costUsd: response.usage.costUsd,
      cycleId: state.cycleId,
      reviewCount: state.reviewCount,
      status: "passed",
    };
  }

  state.lifecycle = "waiting_final_signal";
  recordReview(
    deps,
    state,
    {
      findings: response.review.findings,
      packetHash: packet.hash,
      review: response.review,
      reviewNumber: 1,
      reviewedSha: pr.headSha,
      usage: response.usage,
    },
    now
  );

  await setCheck(deps, state, {
    conclusion: "action_required",
    details: `${renderFindingsMarkdown(response.review.findings)}${findingsJson(
      response.review.findings
    )}`,
    status: "completed",
    summary: `${response.review.findings.length} material finding(s). Fix, push, then label \`${FINAL_SIGNAL_LABEL}\`.`,
    title: "Frontier review: changes required",
  });
  await deps.github.postComment(
    state.repo,
    state.prNumber,
    reviewSummaryComment(response.review)
  );

  return {
    calls: 1,
    costUsd: response.usage.costUsd,
    cycleId: state.cycleId,
    reviewCount: state.reviewCount,
    status: "waiting_final_signal",
  };
};

const attemptFinalReview = async (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  now: Date
): Promise<FrontierOutcome> => {
  const pr = await deps.github.getPullRequest(state.repo, state.prNumber);
  state.headSha = pr.headSha;

  const from = state.initialReviewSha;

  if (!from || pr.headSha === from) {
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "no repair push since review #1",
      reviewCount: state.reviewCount,
      status: "waiting_final_signal",
    };
  }

  const ci = await resolveCi(deps, state.repo, pr.baseBranch, pr.headSha);

  if (!ci.ok) {
    if (ci.failed.length > 0) {
      state.lifecycle = "ci_failed";
      await setCheck(deps, state, {
        conclusion: "neutral",
        status: "completed",
        summary: `Required CI is failing on the repair push: ${ci.failed
          .map((run) => `${run.name} (${run.conclusion})`)
          .join(", ")}. No frontier tokens were spent.`,
        title: "Frontier final review waiting on CI",
      });
      return {
        calls: 0,
        costUsd: 0,
        cycleId: state.cycleId,
        detail: "required CI failed on repair push",
        reviewCount: state.reviewCount,
        status: "ci_failed",
      };
    }

    await setCheck(deps, state, {
      status: "in_progress",
      summary: `Waiting for required checks before final review: ${ci.pending.join(", ") || "unknown"}`,
      title: "Frontier final review waiting for CI",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "required CI pending on repair push",
      reviewCount: state.reviewCount,
      status: "waiting_ci",
    };
  }

  const diff = await deps.github.getDeltaDiff(state.repo, from, pr.headSha);
  const packet = buildPacket({
    baseSha: from,
    body: pr.body,
    ciEvidence: ci.evidence,
    contextFiles: [],
    delta: { fromSha: from, originalFindings: state.findings ?? [] },
    diff,
    files: [],
    gateReasons: state.gate?.reasons ?? [],
    headSha: pr.headSha,
    limits: deps.limits,
    linkedIssue: null,
    prNumber: state.prNumber,
    repo: state.repo,
    title: pr.title,
  });

  if (packet.unsafe) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Delta packet could not be built safely: ${packet.reason}`,
      title: "Frontier final review needs manual review",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: packet.reason,
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  const key = idempotencyKey({
    cycleId: state.cycleId,
    packetHash: packet.hash,
    prNumber: state.prNumber,
    repo: state.repo,
    reviewNumber: 2,
    reviewedSha: pr.headSha,
  });

  if (await deps.kv.get(key)) {
    emit(deps, "frontier.idempotent_hit", { reviewNumber: 2 });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "review #2 already paid for this packet",
      reviewCount: state.reviewCount,
      status: "already_reviewed",
    };
  }

  const budget = await reserveBudget(
    deps.kv,
    now,
    deps.budget,
    deps.budget.maxCallUsd
  );
  if (!budget.allowed) {
    state.lifecycle = "budget_exhausted";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Final frontier review skipped: ${budget.reason}`,
      title: "Frontier review skipped: budget exhausted",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: `budget: ${budget.reason}`,
      reviewCount: state.reviewCount,
      status: "budget_exhausted",
    };
  }

  await setCheck(deps, state, {
    status: "in_progress",
    summary: "Frontier final review running",
    title: "Frontier final review running",
  });

  let response;
  try {
    response = await deps.model.review({
      maxTokens: deps.limits.maxOutputTokens,
      system: FRONTIER_SYSTEM_PROMPT,
      user: packet.text,
    });
  } catch (error) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Frontier final review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      title: "Frontier final review failed",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "model call failed",
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  await deps.kv.set(key, 1, IDEMPOTENCY_TTL_MS);
  await reconcileBudget(
    deps.kv,
    now,
    deps.budget.maxCallUsd,
    response.usage.costUsd
  );

  state.finalReviewSha = pr.headSha;
  state.finalSignalPending = false;
  state.findings = response.review.findings;

  recordReview(
    deps,
    state,
    {
      findings: response.review.findings,
      packetHash: packet.hash,
      review: response.review,
      reviewNumber: 2,
      reviewedSha: pr.headSha,
      usage: response.usage,
    },
    now
  );

  const blocking = blockingFindings(response.review.findings);

  if (response.review.verdict === "pass" && blocking.length === 0) {
    state.lifecycle = "passed";
    await setCheck(deps, state, {
      conclusion: "success",
      status: "completed",
      summary: response.review.summary || "Final frontier review passed.",
      title: "Frontier review passed",
    });
    return {
      calls: 1,
      costUsd: response.usage.costUsd,
      cycleId: state.cycleId,
      reviewCount: state.reviewCount,
      status: "passed",
    };
  }

  state.lifecycle = "blocked";
  await setCheck(deps, state, {
    conclusion: "failure",
    details: `${renderFindingsMarkdown(response.review.findings)}${findingsJson(
      response.review.findings
    )}`,
    status: "completed",
    summary: `Blocked: ${blocking.length} blocking finding(s) remain. Add \`${NEW_CYCLE_LABEL}\` to start a new bounded cycle.`,
    title: "Frontier final review blocked",
  });
  await deps.github.postComment(
    state.repo,
    state.prNumber,
    [
      "## Frontier final review: BLOCKED",
      "",
      response.review.summary || "_No summary provided._",
      "",
      renderFindingsMarkdown(response.review.findings),
      "",
      "---",
      "",
      `This cycle is complete. Further pushes will not trigger another paid review. To start a new bounded cycle after remediation, add the \`${NEW_CYCLE_LABEL}\` label.`,
    ].join("\n")
  );

  return {
    calls: 1,
    costUsd: response.usage.costUsd,
    cycleId: state.cycleId,
    reviewCount: state.reviewCount,
    status: "blocked",
  };
};

const evaluate = (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  options: { forceReview?: boolean },
  now: Date
): Promise<FrontierOutcome> => {
  if (state.reviewCount >= deps.limits.maxReviewsPerCycle) {
    emit(deps, "frontier.cycle_complete", {
      cycleId: state.cycleId,
      lifecycle: state.lifecycle,
      prNumber: state.prNumber,
      repo: state.repo,
      reviewCount: state.reviewCount,
    });
    return settled({
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "review budget for this cycle is spent",
      reviewCount: state.reviewCount,
      status: state.lifecycle,
    });
  }

  if (state.reviewCount === 1) {
    if (state.finalSignalPending) {
      return attemptFinalReview(deps, state, now);
    }

    return settled({
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: "repair push; waiting for explicit final signal",
      reviewCount: state.reviewCount,
      status: state.lifecycle,
    });
  }

  return runFirstReview(deps, state, options, now);
};

const handleLabel = (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  event: FrontierEvent,
  now: Date
): Promise<FrontierOutcome> => {
  const label = event.label ?? "";

  if (label === NEW_CYCLE_LABEL) {
    if (state.reviewCount < deps.limits.maxReviewsPerCycle) {
      return settled({
        calls: 0,
        costUsd: 0,
        cycleId: state.cycleId,
        detail: "no completed cycle to reset",
        reviewCount: state.reviewCount,
        status: state.lifecycle,
      });
    }

    state.cycleId += 1;
    state.reviewCount = 0;
    state.findings = undefined;
    state.initialReviewSha = undefined;
    state.finalReviewSha = undefined;
    state.finalSignalPending = false;
    state.packetHashes = [];
    state.baselineSha = state.headSha;
    state.lifecycle = "idle";

    emit(deps, "frontier.new_cycle", {
      cycleId: state.cycleId,
      prNumber: state.prNumber,
      repo: state.repo,
    });

    return runFirstReview(deps, state, {}, now);
  }

  if (label === FINAL_SIGNAL_LABEL) {
    if (state.reviewCount !== 1) {
      return settled({
        calls: 0,
        costUsd: 0,
        cycleId: state.cycleId,
        detail: "no review #1 to finalise",
        reviewCount: state.reviewCount,
        status: state.lifecycle,
      });
    }

    state.finalSignalPending = true;
    emit(deps, "frontier.final_signal_armed", {
      cycleId: state.cycleId,
      prNumber: state.prNumber,
      repo: state.repo,
    });

    return attemptFinalReview(deps, state, now);
  }

  return evaluate(
    deps,
    state,
    { forceReview: label === FORCE_REVIEW_LABEL },
    now
  );
};

/**
 * Single entry point for the automatic path. Enforces, in order:
 * delivery dedup → per-PR lock → per-cycle review budget → gate → required CI
 * → budget → packet safety → paid-call idempotency → exactly one model call.
 */
export const handleFrontierEvent = async (
  deps: FrontierEngineDeps,
  event: FrontierEvent
): Promise<FrontierOutcome> => {
  const now = nowOf(deps);

  if (event.deliveryId) {
    const seen = await deps.kv.get(deliveryKey(event.deliveryId));
    if (seen) {
      emit(deps, "frontier.duplicate_delivery", {
        deliveryId: event.deliveryId,
      });
      return {
        calls: 0,
        costUsd: 0,
        cycleId: 0,
        detail: "duplicate GitHub delivery",
        reviewCount: 0,
        status: "duplicate",
      };
    }
    await deps.kv.set(
      deliveryKey(event.deliveryId),
      1,
      14 * 24 * 60 * 60 * 1000
    );
  }

  const lockKey = `frontier:lock:${event.repo}#${event.prNumber}`;
  let lock: unknown = null;

  if (deps.kv.acquireLock) {
    lock = await deps.kv.acquireLock(lockKey, 120_000);
    if (!lock) {
      emit(deps, "frontier.lock_held", {
        prNumber: event.prNumber,
        repo: event.repo,
      });
      return {
        calls: 0,
        costUsd: 0,
        cycleId: 0,
        detail: "another delivery is processing this PR",
        reviewCount: 0,
        status: "locked",
      };
    }
  }

  try {
    const state =
      (await loadPrState(deps.kv, event.repo, event.prNumber)) ??
      createInitialState({
        headSha: "",
        now,
        prNumber: event.prNumber,
        repo: event.repo,
      });

    if (event.headSha) {
      state.headSha = event.headSha;
    }

    const outcome =
      event.kind === "label"
        ? await handleLabel(deps, state, event, now)
        : await evaluate(deps, state, {}, now);

    await savePrState(deps.kv, state, now);

    emit(deps, "frontier.outcome", {
      calls: outcome.calls,
      cycleId: state.cycleId,
      lifecycle: state.lifecycle,
      prNumber: state.prNumber,
      repo: state.repo,
      reviewCount: state.reviewCount,
      status: outcome.status,
    });

    return {
      ...outcome,
      cycleId: state.cycleId,
      reviewCount: state.reviewCount,
    };
  } finally {
    if (lock && deps.kv.releaseLock) {
      await deps.kv.releaseLock(lock);
    }
  }
};

export const isTerminalLifecycle = (lifecycle: string): boolean =>
  TERMINAL_LIFECYCLES.has(lifecycle);
