import type { GateChangedFile } from "@/lib/frontier/gate";

export interface PullRequestView {
  baseBranch: string;
  baseSha: string;
  body: string;
  headBranch: string;
  headSha: string;
  labels: string[];
  number: number;
  repo: string;
  title: string;
}

export interface CheckRunView {
  conclusion: string | null;
  name: string;
  status: string;
}

export interface LinkedIssue {
  body: string;
  number: number;
  title: string;
}

export type FrontierCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "success"
  | "timed_out";

export interface FrontierCheckUpdate {
  conclusion?: FrontierCheckConclusion;
  details?: string;
  headSha: string;
  name: string;
  prNumber: number;
  repo: string;
  status: "completed" | "in_progress" | "queued";
  summary: string;
  title: string;
}

/**
 * Everything the engine needs from GitHub. Kept as an interface so the accept
 * tests can drive scenarios A–J deterministically without a live API.
 */
export interface FrontierGitHub {
  getChangedFiles: (
    repo: string,
    prNumber: number
  ) => Promise<GateChangedFile[]>;
  getDeltaDiff: (
    repo: string,
    fromSha: string,
    toSha: string
  ) => Promise<string>;
  getDiff: (repo: string, prNumber: number) => Promise<string>;
  getFileContent: (
    repo: string,
    path: string,
    ref: string
  ) => Promise<string | null>;
  getLinkedIssue: (
    repo: string,
    prNumber: number
  ) => Promise<LinkedIssue | null>;
  getPullRequest: (repo: string, prNumber: number) => Promise<PullRequestView>;
  getRepoConfig: (repo: string, ref: string) => Promise<string | null>;
  getRequiredChecks: (
    repo: string,
    baseBranch: string,
    ref: string
  ) => Promise<string[]>;
  listCheckRuns: (repo: string, ref: string) => Promise<CheckRunView[]>;
  postComment: (repo: string, prNumber: number, body: string) => Promise<void>;
  setFrontierCheck: (update: FrontierCheckUpdate) => Promise<number>;
}
