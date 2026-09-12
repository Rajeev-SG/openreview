import "server-only";
import type { Octokit } from "octokit";

import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  CheckRunView,
  FrontierGitHub,
  LinkedIssue,
  PullRequestView,
} from "@/lib/frontier/github";
import { FRONTIER_CHECK_NAME } from "@/lib/frontier/types";
import { getInstallationOctokit } from "@/lib/github";

const CONFIG_PATHS = [
  ".github/frontier-review.yml",
  ".github/frontier-review.yaml",
  ".github/frontier.yml",
];

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 500;
const MAX_CHECK_RUNS = 100;

interface RepoParts {
  owner: string;
  repo: string;
}

const split = (repo: string): RepoParts => {
  const [owner, repoName] = repo.split("/");
  return { owner, repo: repoName };
};

const decodeBase64 = (value: string): string =>
  Buffer.from(value.replaceAll("\n", ""), "base64").toString("utf8");

/**
 * Optional explicit required-check list. Mirrors the branch-protection lookup,
 * and exists so operators can gate frontier spend without configuring branch
 * protection (for example on private repos where protection is unavailable).
 */
const requiredChecksOverride = (): string[] =>
  (process.env.FRONTIER_REQUIRED_CHECKS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

const linkedIssueNumber = (body: string): number | null => {
  const match = body.match(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/i
  );
  return match ? Number(match[1]) : null;
};

export const createOctokitFrontierGitHub = (
  octokitPromise?: Promise<Octokit>
): FrontierGitHub => {
  const client = (): Promise<Octokit> =>
    octokitPromise ?? getInstallationOctokit();

  const readFile = async (
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> => {
    const { owner, repo: name } = split(repo);
    const clientValue = await client();

    try {
      const { data } = await clientValue.rest.repos.getContent({
        owner,
        path,
        ref,
        repo: name,
      });

      if (
        Array.isArray(data) ||
        data.type !== "file" ||
        typeof data.content !== "string" ||
        (data.size ?? 0) > MAX_FILE_BYTES
      ) {
        return null;
      }

      return decodeBase64(data.content);
    } catch (error) {
      const { status } = error as { status?: number };
      if (status === 404) {
        return null;
      }
      throw error;
    }
  };

  return {
    getChangedFiles: async (
      repo: string,
      prNumber: number
    ): Promise<GateChangedFile[]> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();

      const files = await clientValue.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        { owner, per_page: 100, pull_number: prNumber, repo: name }
      );

      return files.slice(0, MAX_FILES).map((file) => ({
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        path: file.filename,
        status: file.status,
      }));
    },

    getDeltaDiff: async (
      repo: string,
      fromSha: string,
      toSha: string
    ): Promise<string> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const response = await clientValue.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          basehead: `${fromSha}...${toSha}`,
          headers: { accept: "application/vnd.github.v3.diff" },
          owner,
          repo: name,
        }
      );
      return typeof response.data === "string" ? response.data : "";
    },

    getDiff: async (repo: string, prNumber: number): Promise<string> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const response = await clientValue.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          headers: { accept: "application/vnd.github.v3.diff" },
          owner,
          pull_number: prNumber,
          repo: name,
        }
      );
      return typeof response.data === "string" ? response.data : "";
    },

    getFileContent: readFile,

    getLinkedIssue: async (
      repo: string,
      prNumber: number
    ): Promise<LinkedIssue | null> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const { data: pr } = await clientValue.rest.pulls.get({
        owner,
        pull_number: prNumber,
        repo: name,
      });

      const number = linkedIssueNumber(pr.body ?? "");

      if (!number) {
        return null;
      }

      try {
        const { data: issue } = await clientValue.rest.issues.get({
          issue_number: number,
          owner,
          repo: name,
        });

        return {
          body: issue.body ?? "",
          number: issue.number,
          title: issue.title,
        };
      } catch {
        return null;
      }
    },

    getPullRequest: async (
      repo: string,
      prNumber: number
    ): Promise<PullRequestView> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const { data } = await clientValue.rest.pulls.get({
        owner,
        pull_number: prNumber,
        repo: name,
      });

      return {
        baseBranch: data.base.ref,
        baseSha: data.base.sha,
        body: data.body ?? "",
        headBranch: data.head.ref,
        headSha: data.head.sha,
        labels: data.labels.map((label) =>
          typeof label === "string" ? label : (label.name ?? "")
        ),
        number: data.number,
        repo,
        title: data.title,
      };
    },

    getRepoConfig: async (
      repo: string,
      ref: string
    ): Promise<string | null> => {
      for (const path of CONFIG_PATHS) {
        const content = await readFile(repo, path, ref);
        if (content !== null) {
          return content;
        }
      }
      return null;
    },

    getRequiredChecks: async (
      repo: string,
      baseBranch: string
    ): Promise<string[]> => {
      const override = requiredChecksOverride();
      if (override.length > 0) {
        return override;
      }

      const { owner, repo: name } = split(repo);
      const clientValue = await client();

      try {
        const { data } = await clientValue.request(
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
          { branch: baseBranch, owner, repo: name }
        );

        const contexts = data.contexts ?? [];
        const checks = (data.checks ?? []).map((check) => check.context);

        return [...new Set([...contexts, ...checks])].filter(Boolean);
      } catch (error) {
        const { status } = error as { status?: number };
        if (status === 404 || status === 403) {
          return [];
        }
        throw error;
      }
    },

    listCheckRuns: async (
      repo: string,
      ref: string
    ): Promise<CheckRunView[]> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const response = await clientValue.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          filter: "latest",
          owner,
          per_page: MAX_CHECK_RUNS,
          ref,
          repo: name,
        }
      );

      return (response.data.check_runs ?? []).map((run) => ({
        conclusion: run.conclusion,
        name: run.name,
        status: run.status,
      }));
    },

    postComment: async (
      repo: string,
      prNumber: number,
      body: string
    ): Promise<void> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      await clientValue.rest.issues.createComment({
        body,
        issue_number: prNumber,
        owner,
        repo: name,
      });
    },

    setFrontierCheck: async (update): Promise<number> => {
      const { owner, repo: name } = split(update.repo);
      const clientValue = await client();
      const existing = await clientValue.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          check_name: FRONTIER_CHECK_NAME,
          filter: "latest",
          owner,
          per_page: 20,
          ref: update.headSha,
          repo: name,
        }
      );

      const previous = (existing.data.check_runs ?? []).find(
        (run) => run.name === FRONTIER_CHECK_NAME
      );

      if (previous) {
        const { data } = await clientValue.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
            check_run_id: previous.id,
            conclusion: update.conclusion,
            output: {
              summary: update.summary.slice(0, 65_000),
              text: update.details?.slice(0, 65_000),
              title: update.title,
            },
            owner,
            repo: name,
            status: update.status,
          }
        );
        return data.id;
      }

      const { data } = await clientValue.request(
        "POST /repos/{owner}/{repo}/check-runs",
        {
          conclusion: update.conclusion,
          head_sha: update.headSha,
          name: FRONTIER_CHECK_NAME,
          output: {
            summary: update.summary.slice(0, 65_000),
            text: update.details?.slice(0, 65_000),
            title: update.title,
          },
          owner,
          repo: name,
          status: update.status,
        }
      );

      return data.id;
    },
  };
};
