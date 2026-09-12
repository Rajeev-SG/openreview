import { DEFAULT_FRONTIER_LIMITS } from "@/lib/frontier/config";
import type { FrontierEngineDeps, FrontierEvent } from "@/lib/frontier/engine";
import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  CheckRunView,
  FrontierCheckUpdate,
  FrontierGitHub,
  LinkedIssue,
  PullRequestView,
} from "@/lib/frontier/github";
import type {
  FrontierModelClient,
  FrontierModelResponse,
} from "@/lib/frontier/model";
import { createMemoryKv } from "@/lib/frontier/store";
import type { FrontierKv } from "@/lib/frontier/store";
import type {
  FrontierBudgetLimits,
  FrontierFinding,
  FrontierLimits,
  FrontierReview,
} from "@/lib/frontier/types";

export interface FakeRepoState {
  checks: CheckRunView[];
  config?: string | null;
  deltaDiffs?: Record<string, string>;
  diff: string;
  fileContents?: Record<string, string>;
  files: GateChangedFile[];
  issue?: LinkedIssue | null;
  pr: PullRequestView;
  required: string[];
}

export interface FakeGitHub {
  checkUpdates: FrontierCheckUpdate[];
  comments: string[];
  github: FrontierGitHub;
  state: FakeRepoState;
}

/** Yield to the microtask queue so doubles behave like real async clients. */
export const yieldMicrotask = async (): Promise<void> => {
  await Promise.resolve();
};

export const HARNESS_NOW = new Date("2026-09-12T12:00:00.000Z");

export const createFakeGitHub = (state: FakeRepoState): FakeGitHub => {
  const comments: string[] = [];
  const checkUpdates: FrontierCheckUpdate[] = [];
  let checkId = 0;

  const github: FrontierGitHub = {
    getChangedFiles: async () => {
      await yieldMicrotask();
      return state.files;
    },
    getDeltaDiff: async (_repo, fromSha, toSha) => {
      await yieldMicrotask();
      return state.deltaDiffs?.[`${fromSha}..${toSha}`] ?? state.diff;
    },
    getDiff: async () => {
      await yieldMicrotask();
      return state.diff;
    },
    getFileContent: async (_repo, path) => {
      await yieldMicrotask();
      return state.fileContents?.[path] ?? null;
    },
    getLinkedIssue: async () => {
      await yieldMicrotask();
      return state.issue ?? null;
    },
    getPullRequest: async () => {
      await yieldMicrotask();
      return state.pr;
    },
    getRepoConfig: async () => {
      await yieldMicrotask();
      return state.config ?? null;
    },
    getRequiredChecks: async () => {
      await yieldMicrotask();
      return state.required;
    },
    listCheckRuns: async () => {
      await yieldMicrotask();
      return state.checks;
    },
    postComment: async (_repo, _prNumber, body) => {
      await yieldMicrotask();
      comments.push(body);
    },
    setFrontierCheck: async (update) => {
      await yieldMicrotask();
      checkUpdates.push(update);
      checkId += 1;
      return checkId;
    },
  };

  return { checkUpdates, comments, github, state };
};

export interface FakeModel {
  calls: { maxTokens: number; user: string }[];
  model: FrontierModelClient;
}

export const DEFAULT_USAGE = {
  costUsd: 0.0125,
  inputTokens: 4200,
  model: "z-ai/glm-5.3",
  outputTokens: 640,
};

export const createFakeModel = (
  queue: FrontierReview[],
  usage = DEFAULT_USAGE
): FakeModel => {
  const calls: { maxTokens: number; user: string }[] = [];
  let index = 0;

  const model: FrontierModelClient = {
    review: async (request): Promise<FrontierModelResponse> => {
      await yieldMicrotask();
      calls.push({ maxTokens: request.maxTokens, user: request.user });
      const review =
        queue[index] ??
        ({
          findings: [],
          summary: "Looks fine.",
          verdict: "pass",
        } satisfies FrontierReview);
      index += 1;
      return { review, usage };
    },
  };

  return { calls, model };
};

export const finding = (
  overrides: Partial<FrontierFinding> = {}
): FrontierFinding => ({
  category: "correctness",
  id: "F1",
  impact: "the gate can overspend",
  problem: "budget is checked after the model call",
  required_fix: "check the budget before the call",
  severity: "P1",
  verification: "add a regression test",
  ...overrides,
});

export const defaultRepo = (
  overrides: Partial<FakeRepoState> = {}
): FakeRepoState => ({
  checks: [{ conclusion: "success", name: "ci", status: "completed" }],
  config: null,
  diff: [
    "diff --git a/lib/model.ts b/lib/model.ts",
    "--- a/lib/model.ts",
    "+++ b/lib/model.ts",
    "@@ -1,3 +1,3 @@",
    "-const a = 1;",
    "+const a = 2;",
  ].join("\n"),
  fileContents: {},
  files: [
    { additions: 10, deletions: 2, path: "lib/model.ts", status: "modified" },
    { additions: 5, deletions: 0, path: "test/model.test.ts", status: "added" },
  ],
  issue: { body: "Do the thing.", number: 1, title: "Do the thing" },
  pr: {
    baseBranch: "main",
    baseSha: "base0001",
    body: "Closes #1",
    headBranch: "feat/thing",
    headSha: "head0001",
    labels: [],
    number: 7,
    repo: "acme/widgets",
    title: "Fix the thing",
  },
  required: ["ci"],
  ...overrides,
});

export interface Harness {
  deps: FrontierEngineDeps;
  fakeGitHub: FakeGitHub;
  kv: ReturnType<typeof createMemoryKv>;
  limits: FrontierLimits;
  model: FakeModel;
  setNow: (date: Date) => void;
}

export const createHarness = (input?: {
  budget?: FrontierBudgetLimits;
  kv?: FrontierKv;
  limits?: Partial<FrontierLimits>;
  now?: Date;
  reviews?: FrontierReview[];
  repo?: Partial<FakeRepoState>;
  usage?: typeof DEFAULT_USAGE;
}): Harness => {
  const state = defaultRepo(input?.repo);
  const fakeGitHub = createFakeGitHub(state);
  const model = createFakeModel(input?.reviews ?? [], input?.usage);
  const kv = input?.kv ?? createMemoryKv();
  const limits: FrontierLimits = {
    ...DEFAULT_FRONTIER_LIMITS,
    ...input?.limits,
  };
  let now = input?.now ?? HARNESS_NOW;

  return {
    deps: {
      budget: input?.budget ?? {
        dailyUsd: 5,
        inputUsdPerMTok: 1.4,
        maxCallUsd: 0.5,
        monthlyUsd: 50,
        outputUsdPerMTok: 4.4,
      },
      github: fakeGitHub.github,
      isDurableState: true,
      kv,
      limits,
      model: model.model,
      now: () => now,
    },
    fakeGitHub,
    kv,
    limits,
    model,
    setNow: (date) => {
      now = date;
    },
  };
};

export const reviewPrompt = (model: FakeModel, index: number): string => {
  const call = model.calls.at(index);

  if (!call) {
    throw new Error(`no model call recorded at index ${index}`);
  }

  return call.user;
};

export const pullRequestEvent = (
  overrides: Partial<FrontierEvent> = {}
): FrontierEvent => ({
  action: "opened",
  deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
  headSha: "head0001",
  kind: "pull_request",
  prNumber: 7,
  repo: "acme/widgets",
  ...overrides,
});

export const labelEvent = (
  label: string,
  overrides: Partial<FrontierEvent> = {}
): FrontierEvent =>
  pullRequestEvent({
    action: "labeled",
    kind: "label",
    label,
    ...overrides,
  });
