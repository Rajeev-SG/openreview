import {
  deriveReservationUsd,
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
import {
  FRONTIER_SYSTEM_PROMPT,
  FrontierModelError,
} from "@/lib/frontier/model";
import type { FrontierModelClient } from "@/lib/frontier/model";
import { buildPacket, renderFindingsMarkdown } from "@/lib/frontier/packet";
import type { PacketContextFile } from "@/lib/frontier/packet";
import {
  buildResolutionReport,
  parseFileChanges,
  renderResolutionMarkdown,
} from "@/lib/frontier/resolution";
import {
  createInitialState,
  DELIVERY_TTL_MS,
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
  ResolutionReport,
} from "@/lib/frontier/types";

export interface FrontierEngineDeps {
  budget: FrontierBudgetLimits;
  github: FrontierGitHub;
  /**
   * Whether `kv` outlives a single invocation. Every spend invariant (per-cycle
   * review count, paid-call idempotency, dedup, daily/monthly ledger) is
   * enforced through `kv`, so on an ephemeral store the ceilings cannot be
   * honoured and a cold start can re-run a paid review. Absent a durable store
   * the gate therefore fails closed instead of spending unbounded.
   */
  isDurableState: boolean;
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

const TERMINAL_LIFECYCLES = new Set(["passed", "blocked", "resolved"]);

/**
 * How long the gate may sit at "waiting for required CI" before it gives up and
 * fails closed. Without a bound, a required check that never reports would park
 * the check at in_progress forever with no explanation.
 */
const DEFAULT_CI_WAIT_MS = 30 * 60 * 1000;

const ciWaitMs = (): number => {
  const raw = Number(process.env.FRONTIER_CI_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CI_WAIT_MS;
};

const ciWaitExpired = (state: FrontierPrState, now: Date): boolean => {
  if (!state.ciWaitingSince) {
    return false;
  }

  return now.getTime() - Date.parse(state.ciWaitingSince) > ciWaitMs();
};

const nowOf = (deps: FrontierEngineDeps): Date => deps.now?.() ?? new Date();

const reservationFor = (deps: FrontierEngineDeps): number =>
  deriveReservationUsd(
    {
      inputUsdPerMTok: deps.budget.inputUsdPerMTok,
      maxOutputTokens: deps.limits.maxOutputTokens,
      maxPacketChars: deps.limits.maxPacketChars,
      outputUsdPerMTok: deps.budget.outputUsdPerMTok,
    },
    deps.budget.maxCallUsd
  );

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
  /** Set when required CI cannot be determined; the caller must not spend. */
  unknown?: string;
}

const resolveCi = async (
  deps: FrontierEngineDeps,
  repo: string,
  baseBranch: string,
  ref: string
): Promise<CiStatus> => {
  const resolved = await deps.github.getRequiredChecks(repo, baseBranch, ref);

  // Fail closed: without a trustworthy view of required CI the gate cannot
  // honour its "wait for required CI before spending" guarantee.
  if (!resolved.known) {
    return {
      evidence: [],
      failed: [],
      ok: false,
      pending: [],
      required: [],
      unknown: resolved.reason,
    };
  }

  const required = resolved.names;
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

/**
 * Handle a required-CI state that is not simply "green": unknown, failing, or
 * still pending. Returns the outcome to short-circuit with, or null to proceed.
 *
 * Parking on a pending check is bounded: a required check that never reports
 * (renamed job, path filter, or a typo in FRONTIER_REQUIRED_CHECKS) must not
 * block the PR forever behind an in_progress check.
 */
const handleCiNotReady = async (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  ci: CiStatus,
  now: Date,
  phase: "final review" | "review #1"
): Promise<FrontierOutcome | null> => {
  if (ci.unknown) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Frontier review skipped: required CI could not be determined (${ci.unknown}). No frontier tokens were spent.`,
      title: "Frontier review needs CI configuration",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: `required CI unknown: ${ci.unknown}`,
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  if (ci.ok) {
    state.ciWaitingSince = undefined;
    return null;
  }

  const where = phase === "review #1" ? "" : " on the repair push";

  if (ci.failed.length > 0) {
    state.lifecycle = "ci_failed";
    await setCheck(deps, state, {
      conclusion: "neutral",
      status: "completed",
      summary: `Required CI is failing${where}: ${ci.failed
        .map((run) => `${run.name} (${run.conclusion})`)
        .join(", ")}. No frontier tokens were spent.`,
      title: "Frontier review skipped: required CI failed",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: `required CI failed${where}`,
      reviewCount: state.reviewCount,
      status: "ci_failed",
    };
  }

  if (ciWaitExpired(state, now)) {
    state.lifecycle = "needs_manual_review";
    await setCheck(deps, state, {
      conclusion: "action_required",
      status: "completed",
      summary: `Frontier review skipped: required checks never reported (${ci.pending.join(", ")}). A required check that never runs is not waited for indefinitely; check FRONTIER_REQUIRED_CHECKS and the branch protection settings.`,
      title: "Frontier review: required check never reported",
    });
    return {
      calls: 0,
      costUsd: 0,
      cycleId: state.cycleId,
      detail: `required checks never reported: ${ci.pending.join(", ")}`,
      reviewCount: state.reviewCount,
      status: "needs_manual_review",
    };
  }

  state.ciWaitingSince ??= now.toISOString();
  state.lifecycle = "waiting_ci";
  await setCheck(deps, state, {
    status: "in_progress",
    summary: `Waiting for required checks${where}: ${ci.pending.join(", ") || "unknown"}`,
    title: `Frontier ${phase} waiting for CI`,
  });
  return {
    calls: 0,
    costUsd: 0,
    cycleId: state.cycleId,
    detail: `required CI pending${where}`,
    reviewCount: state.reviewCount,
    status: "waiting_ci",
  };
};

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

  const ciOutcome = await handleCiNotReady(deps, state, ci, now, "review #1");

  if (ciOutcome) {
    return ciOutcome;
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
    reservationFor(deps)
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
    // Reconcile against what was actually billed; if the model reported no
    // cost, keep the reservation (conservative).
    await reconcileBudget(
      deps.kv,
      now,
      budget.reservationId,
      error instanceof FrontierModelError
        ? error.spentUsd
        : reservationFor(deps)
    );

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
  await reconcileBudget(
    deps.kv,
    now,
    budget.reservationId,
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

  const ciOutcome = await handleCiNotReady(
    deps,
    state,
    ci,
    now,
    "final review"
  );

  if (ciOutcome) {
    return ciOutcome;
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
    reservationFor(deps)
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
    await reconcileBudget(
      deps.kv,
      now,
      budget.reservationId,
      error instanceof FrontierModelError
        ? error.spentUsd
        : reservationFor(deps)
    );

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
    budget.reservationId,
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
      `This cycle is complete: further pushes will not trigger another paid review.`,
      "",
      "Push a repair that changes each flagged file. The gate then re-checks those files and the",
      "required CI **for free** (no model call); if every blocking finding's file changed and CI is",
      "green, the check clears and the PR can merge. Findings the gate cannot verify that way stay",
      "blocked - fix them by hand, or start a new bounded cycle with the",
      `\`${NEW_CYCLE_LABEL}\` label.`,
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

/**
 * Free, deterministic resolution pass after a BLOCK.
 *
 * The cycle's two paid reviews are spent, so a repair push cannot buy another
 * opinion. Rather than leaving a required check red forever, verify the repair
 * deterministically: every blocking finding must name a file, that file must
 * have changed since the blocked review, and required CI must be green. This
 * spends nothing.
 *
 * It proves the flagged file changed and CI passed - not that the repair is
 * semantically right (that was review #2's job). A finding that names no file
 * cannot be verified this way and stays unresolved, so the PR stays blocked
 * until a human or a new cycle resolves it.
 *
 * Writes the check only when the map changes, because every write produces a
 * `check_run` event that re-enters this function.
 */
const attemptResolution = async (
  deps: FrontierEngineDeps,
  state: FrontierPrState
): Promise<FrontierOutcome> => {
  const fromSha = state.finalReviewSha ?? "";
  const pr = await deps.github.getPullRequest(state.repo, state.prNumber);
  const ci = await resolveCi(deps, state.repo, pr.baseBranch, state.headSha);
  const diff = await deps.github.getDeltaDiff(
    state.repo,
    fromSha,
    state.headSha
  );

  const report: ResolutionReport = buildResolutionReport({
    changes: parseFileChanges(diff),
    findings: blockingFindings(state.findings ?? []),
    requiredCiGreen: ci.unknown ? false : ci.ok,
  });

  // Re-entry guard on a stable key: the head SHA plus the yes/no verdict. The
  // evidence text can change without the verdict changing (a transient CI
  // message, a different path-match mode), and rewriting the check for that
  // would post another comment and re-enter this function for nothing.
  const unchanged =
    state.resolutionSha === state.headSha &&
    state.resolutionResolved === report.resolved;

  emit(deps, "frontier.resolution", {
    addressed: report.entries.length - report.unresolved.length,
    prNumber: state.prNumber,
    repo: state.repo,
    resolved: report.resolved,
    unresolved: report.unresolved.length,
  });

  if (!unchanged) {
    if (report.resolved) {
      await setCheck(deps, state, {
        conclusion: "success",
        details: `${renderResolutionMarkdown(report)}${findingsJson(
          state.findings ?? []
        )}`,
        status: "completed",
        summary:
          "Blocking findings resolved without a frontier call: " +
          `${report.entries.length} finding(s) show a changed file and green required CI. ` +
          "This is a deterministic check, not a re-review.",
        title: "Frontier findings resolved (no re-review)",
      });
      await deps.github.postComment(
        state.repo,
        state.prNumber,
        [
          "## Frontier: blocking findings resolved (no frontier call)",
          "",
          renderResolutionMarkdown(report),
          "",
          "Each blocking finding's file changed at the flagged location and required CI is green.",
          "The paid review budget for this cycle stays spent; no new opinion was bought.",
          "",
          "This is a deterministic resolution check, not a semantic re-review. A finding that",
          "needed judgement rather than a testable fix should be re-opened deliberately with",
          "`frontier-new-cycle`.",
        ].join("\n")
      );
    } else {
      await setCheck(deps, state, {
        conclusion: "failure",
        details: renderResolutionMarkdown(report),
        status: "completed",
        summary:
          `Blocked: ${report.unresolved.length} of ${report.entries.length} finding(s) not yet ` +
          `deterministically resolved${ci.unknown ? ` (${ci.unknown})` : ""}. ` +
          "Push a repair that changes each flagged file at the flagged line; required CI must be green.",
        title: "Frontier final review blocked",
      });
    }
  }

  // State is written only after the GitHub writes succeed, so a failed check
  // write cannot leave durable state claiming a resolution that was never
  // posted. A retry re-runs the pass and converges on the same verdict.
  state.lifecycle = report.resolved ? "resolved" : "blocked";
  state.resolution = report;
  state.resolutionResolved = report.resolved;
  state.resolutionSha = state.headSha;

  return {
    calls: 0,
    costUsd: 0,
    cycleId: state.cycleId,
    detail: report.resolved
      ? "blocking findings resolved deterministically"
      : "resolution incomplete",
    reviewCount: state.reviewCount,
    status: report.resolved ? "resolved" : "blocked",
  };
};

const evaluate = (
  deps: FrontierEngineDeps,
  state: FrontierPrState,
  options: { forceReview?: boolean },
  now: Date
): Promise<FrontierOutcome> => {
  if (state.reviewCount >= deps.limits.maxReviewsPerCycle) {
    // A blocked cycle that received a repair push gets the free deterministic
    // resolution pass instead of a dead end. A *passed* cycle is left alone -
    // its findings list is empty, so there is nothing to resolve.
    if (
      (state.lifecycle === "blocked" || state.lifecycle === "resolved") &&
      state.finalReviewSha &&
      state.headSha !== state.finalReviewSha
    ) {
      return attemptResolution(deps, state);
    }

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

  // Durable state is checked before any store access: on an ephemeral store the
  // adapter may not even be connected, and every spend invariant depends on
  // state outliving the invocation.
  if (!deps.isDurableState) {
    emit(deps, "frontier.no_durable_state", {
      prNumber: event.prNumber,
      repo: event.repo,
    });

    try {
      await deps.github.setFrontierCheck({
        conclusion: "neutral",
        headSha: event.headSha ?? "",
        name: FRONTIER_CHECK_NAME,
        prNumber: event.prNumber,
        repo: event.repo,
        status: "completed",
        summary:
          "Frontier review disabled: durable state (REDIS_URL) is not configured. " +
          "The per-cycle review limit, paid-call idempotency and daily/monthly " +
          "budgets cannot be enforced on an ephemeral store, so no frontier " +
          "tokens were spent.",
        title: "Frontier review needs durable state",
      });
    } catch {
      // Reporting is best-effort; the important part is that nothing was spent.
    }

    return {
      calls: 0,
      costUsd: 0,
      cycleId: 0,
      detail: "durable state not configured",
      reviewCount: 0,
      status: "needs_durable_state",
    };
  }

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

    // Record the delivery only after the work completed. Writing it up front
    // would make a Workflow retry (e.g. a transient GitHub error after the
    // dedup write) short-circuit as a "duplicate" and never finish the event.
    if (event.deliveryId) {
      await deps.kv.set(deliveryKey(event.deliveryId), 1, DELIVERY_TTL_MS);
    }

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
