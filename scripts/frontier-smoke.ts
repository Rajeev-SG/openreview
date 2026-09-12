/**
 * Live smoke check for the frontier quality gate.
 *
 * Runs the real deterministic gate, the real packet builder and real OpenRouter
 * judge calls against a real pull request, then proves that repair pushes cost
 * nothing. Prints exact token usage and cost per review.
 *
 * Usage:
 *   bun run smoke:frontier                 # review #1 + free repair push
 *   bun run smoke:frontier -- --cycle <sha> # full two-call cycle from <sha>
 *
 * Reads OPENROUTER_API_KEY from the environment or a local .env.local.
 */

import { execFileSync } from "node:child_process";

import { readSpend } from "@/lib/frontier/budget";
import { handleFrontierEvent } from "@/lib/frontier/engine";
import type { FrontierEngineDeps, FrontierEvent } from "@/lib/frontier/engine";
import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  CheckRunView,
  FrontierCheckUpdate,
  FrontierGitHub,
  PullRequestView,
} from "@/lib/frontier/github";
import { createOpenRouterFrontierModel } from "@/lib/frontier/model";
import { createMemoryKv } from "@/lib/frontier/store";
import { FINAL_SIGNAL_LABEL } from "@/lib/frontier/types";

const MAX_CALL_USD = 0.5;

const loadEnvFile = async (path: string): Promise<void> => {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return;
  }

  const text = await file.text();

  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);

    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  }
};

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Yield to the microtask queue so the in-memory GitHub double behaves async. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
};

interface ApiFile {
  additions: number;
  deletions: number;
  filename: string;
  status: string;
}

interface ApiCheckRun {
  conclusion: string | null;
  name: string;
  status: string;
}

interface PrJson {
  baseRefName: string;
  baseRefOid: string;
  body: string;
  headRefOid: string;
  labels: { name: string }[];
  number: number;
  title: string;
}

interface ReviewRecord {
  findings: {
    category: string;
    id: string;
    problem: string;
    severity: string;
  }[];
  packetHash: string;
  reviewNumber: number;
  reviewedSha: string;
  usage: {
    costUsd: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
  };
  verdict: string;
}

interface StateView {
  cycleId?: number;
  gate?: { overridden?: string; score?: number; threshold?: number };
  lifecycle?: string;
  reviewCount?: number;
  reviews?: ReviewRecord[];
}

const readState = async (
  kv: ReturnType<typeof createMemoryKv>,
  repo: string,
  prNumber: number
): Promise<StateView | null> =>
  await kv.get<StateView>(`frontier:pr:${repo}#${prNumber}`);

const parseArgs = (): { prNumber?: string; reviewedSha?: string } => {
  const args = process.argv.slice(2);
  const cycleIndex = args.indexOf("--cycle");

  if (cycleIndex === -1) {
    return { prNumber: args.find((arg) => /^\d+$/.test(arg)) };
  }

  return {
    prNumber: args.find((arg) => /^\d+$/.test(arg)),
    reviewedSha: args[cycleIndex + 1],
  };
};

const main = async (): Promise<void> => {
  await loadEnvFile(".env.local");

  const apiKey = process.env.OPENROUTER_API_KEY ?? "";

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required (set it, or run `vercel env pull`)"
    );
  }

  const { prNumber: prArg, reviewedSha } = parseArgs();
  const repo = gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]).trim();
  const prNumber = Number(
    prArg ?? gh(["pr", "view", "--json", "number", "-q", ".number"]).trim()
  );

  const view = JSON.parse(
    gh([
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,baseRefOid,baseRefName,headRefOid,labels",
    ])
  ) as PrJson;

  const apiFiles = JSON.parse(
    gh(["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate"])
  ) as ApiFile[];

  const checkRuns = (
    JSON.parse(
      gh(["api", `repos/${repo}/commits/${view.headRefOid}/check-runs`])
    ) as { check_runs: ApiCheckRun[] }
  ).check_runs;

  const diff = gh(["pr", "diff", String(prNumber)]);

  const files: GateChangedFile[] = apiFiles.map((file) => ({
    additions: file.additions,
    deletions: file.deletions,
    path: file.filename,
    status: file.status,
  }));

  const pr: PullRequestView = {
    baseBranch: view.baseRefName,
    baseSha: view.baseRefOid,
    body: view.body,
    headBranch: "head",
    headSha: reviewedSha ?? view.headRefOid,
    labels: view.labels.map((label) => label.name),
    number: view.number,
    repo,
    title: view.title,
  };

  const checkUpdates: FrontierCheckUpdate[] = [];
  let checkId = 0;

  const github: FrontierGitHub = {
    getChangedFiles: async () => {
      await settle();
      return files;
    },
    getDeltaDiff: async (_repo, fromSha, toSha) => {
      await settle();

      if (fromSha === reviewedSha && toSha === view.headRefOid) {
        return git(["diff", fromSha, toSha]);
      }

      return diff;
    },
    getDiff: async () => {
      await settle();
      return diff;
    },
    getFileContent: async (_repo, path) => {
      await settle();
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : null;
    },
    getLinkedIssue: async () => {
      await settle();
      return null;
    },
    getPullRequest: async () => {
      await settle();
      return pr;
    },
    getRepoConfig: async () => {
      await settle();
      const file = Bun.file(".github/frontier-review.yml");
      return (await file.exists()) ? file.text() : null;
    },
    getRequiredChecks: async () => {
      await settle();
      return ["verify"];
    },
    listCheckRuns: async (): Promise<CheckRunView[]> => {
      await settle();
      return checkRuns;
    },
    postComment: async (_repo, _prNumber, body) => {
      await settle();
      checkUpdates.push({
        details: body.slice(0, 200),
        headSha: pr.headSha,
        name: "pr-comment",
        prNumber: pr.number,
        repo,
        status: "completed",
        summary: "PR comment posted",
        title: "PR comment",
      });
    },
    setFrontierCheck: async (update) => {
      await settle();
      checkUpdates.push(update);
      checkId += 1;
      return checkId;
    },
  };

  const kv = createMemoryKv();

  const deps: FrontierEngineDeps = {
    budget: { dailyUsd: 5, maxCallUsd: MAX_CALL_USD, monthlyUsd: 50 },
    github,
    kv,
    limits: {
      maxContextFiles: 6,
      maxContextPerFileChars: 4000,
      maxDiffChars: 35_000,
      maxLinkedIssueChars: 5000,
      maxOutputTokens: 3000,
      maxPacketChars: 50_000,
      maxPrBodyChars: 4000,
      maxReviewsPerCycle: 2,
    },
    log: (name, meta) => {
      console.error(`[${name}]`, meta ?? "");
    },
    model: createOpenRouterFrontierModel({ apiKey }),
  };

  const event = (overrides: Partial<FrontierEvent>): FrontierEvent => ({
    action: "opened",
    deliveryId: `smoke-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    headSha: pr.headSha,
    kind: "pull_request",
    prNumber: pr.number,
    repo,
    ...overrides,
  });

  console.log(`repo        ${repo}`);
  console.log(`pr          #${pr.number} ${pr.title}`);
  console.log(`head        ${pr.headSha.slice(0, 12)}`);
  console.log(`files       ${files.length}`);
  console.log(
    `checks      ${
      checkRuns
        .map((run) => `${run.name}:${run.conclusion ?? run.status}`)
        .join(", ") || "(none)"
    }`
  );
  console.log("");

  const report = async (label: string, lines: string[]): Promise<void> => {
    const state = await readState(kv, repo, pr.number);
    const reviews = state?.reviews ?? [];
    const latest = reviews.at(-1);

    console.log(`${label} ${lines.join(" ")}`);

    if (!latest) {
      return;
    }

    console.log(
      `  usage     model=${latest.usage.model} in=${latest.usage.inputTokens} out=${latest.usage.outputTokens} cost=$${latest.usage.costUsd.toFixed(6)}`
    );

    for (const item of latest.findings) {
      console.log(
        `  finding   [${item.severity}] ${item.id} (${item.category}) ${item.problem}`
      );
    }
  };

  const first = await handleFrontierEvent(deps, event({}));
  await report("review #1 ", [
    `${first.status} calls=${first.calls}`,
    `gate=${first.status === "skipped" ? "skip" : "review"}`,
  ]);

  // A repair push must cost nothing.
  pr.headSha = view.headRefOid;
  const repairPush = await handleFrontierEvent(
    deps,
    event({ action: "synchronize" })
  );
  console.log(
    `repair push ${repairPush.status} calls=${repairPush.calls} cost=$${repairPush.costUsd}`
  );

  if (repairPush.calls !== 0) {
    throw new Error("repair push spent money: the invariant is broken");
  }

  if (!reviewedSha) {
    const spend = await readSpend(kv, new Date());
    console.log(
      `cycle total calls=${spend.daily.calls} cost=$${spend.daily.costUsd.toFixed(6)}`
    );
    console.log("");
    console.log(
      "Run with `--cycle <reviewedSha>` for the full two-call cycle."
    );
    return;
  }

  const final = await handleFrontierEvent(
    deps,
    event({ action: "labeled", kind: "label", label: FINAL_SIGNAL_LABEL })
  );
  await report("review #2 ", [`${final.status} calls=${final.calls}`]);

  const afterFinal = await handleFrontierEvent(
    deps,
    event({ action: "synchronize" })
  );
  console.log(
    `later push  ${afterFinal.status} calls=${afterFinal.calls} cost=$${afterFinal.costUsd}`
  );

  const state = await readState(kv, repo, pr.number);
  const spend = await readSpend(kv, new Date());
  const cycleCalls = state?.reviews?.length ?? 0;
  const paid = (state?.reviews ?? []).reduce(
    (total, review) => total + review.usage.costUsd,
    0
  );

  console.log("");
  console.log(
    `cycle       reviews=${cycleCalls} cycleId=${state?.cycleId ?? "?"} lifecycle=${state?.lifecycle ?? "?"}`
  );
  console.log(
    `cycle spend calls=${spend.daily.calls} cost=$${spend.daily.costUsd.toFixed(6)} (sum of reviews=$${paid.toFixed(6)})`
  );

  if (cycleCalls > 2) {
    throw new Error("more than two paid reviews in one cycle");
  }
};

await main();
