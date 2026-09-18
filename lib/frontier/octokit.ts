import "server-only";
import type { Octokit } from "octokit";

import {
  classifyRequiredChecksFailure,
  withoutSelfCheck,
} from "@/lib/frontier/checks";
import type { GateChangedFile } from "@/lib/frontier/gate";
import type {
  CheckRunView,
  CommitStatusView,
  FrontierGitHub,
  LinkedIssue,
  PullRequestView,
  RequiredChecksResult,
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
/** Bounded page walk so a busy head cannot hide a required run behind the cap. */
const MAX_CHECK_RUN_PAGES = 10;

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

/**
 * Read the repository's platform required-status-check settings.
 *
 * Shared by every precedence path so "what the platform requires" has exactly
 * one implementation. Legacy commit-status contexts are reported as unknown:
 * they cannot be satisfied by the check-run API, and treating them as a
 * requirement would park every PR until the wait expired.
 */
const readBranchProtection = async (
  client: () => Promise<Octokit>,
  repo: string,
  baseBranch: string
): Promise<RequiredChecksResult> => {
  const { owner, repo: name } = split(repo);
  const clientValue = await client();

  try {
    const { data } = await clientValue.request(
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
      { branch: baseBranch, owner, repo: name }
    );

    const contexts = data.contexts ?? [];
    const checks: { app_id?: number | null; context: string }[] =
      data.checks ?? [];
    const appIds: Record<string, number> = {};

    for (const check of checks) {
      if (typeof check.app_id === "number") {
        appIds[check.context] = check.app_id;
      }
    }

    const checkNames = withoutSelfCheck(checks.map((check) => check.context));
    const statusOnly = withoutSelfCheck(contexts).filter(
      (context) => !checkNames.includes(context)
    );

    if (statusOnly.length > 0) {
      return {
        known: false,
        reason:
          `required context(s) ${statusOnly.join(", ")} are commit statuses, ` +
          "which this gate cannot verify (it reads check runs). Convert them " +
          "to check runs, or declare `required_checks:` in the repo config.",
      };
    }

    return { appIds, known: true, names: checkNames };
  } catch (error) {
    const { status, response } = error as {
      status?: number;
      response?: { data?: { message?: string } };
    };
    const kind = classifyRequiredChecksFailure(status, response?.data?.message);

    // 404, or a plan that cannot offer protection: nothing to wait for.
    if (kind === "none") {
      return { known: true, names: [] };
    }

    // 403: the App cannot read protection. This must NOT masquerade as "no
    // required checks" - the caller would spend without being able to verify CI.
    if (kind === "unreadable") {
      const apiMessage = response?.data?.message;

      return {
        known: false,
        reason:
          `required CI could not be determined (${apiMessage ?? "permission denied reading branch protection"}). ` +
          "Grant repository 'administration: read' on the App, or set FRONTIER_REQUIRED_CHECKS",
      };
    }

    throw error;
  }
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

  /**
   * Every blob path in the repository at `ref`, or "unknown" when the listing
   * cannot be trusted (API failure, truncated tree). "unknown" must keep
   * findings blocking: an untrustworthy listing must never widen the
   * not-verifiable class.
   */
  const listRepoFiles = async (
    repo: string,
    ref: string
  ): Promise<string[] | "unknown"> => {
    const { owner, repo: name } = split(repo);
    try {
      const clientValue = await client();
      const { data } = await clientValue.rest.git.getTree({
        owner,
        recursive: "true",
        repo: name,
        tree_sha: ref,
      });
      if (data.truncated) {
        return "unknown";
      }
      return data.tree
        .filter((entry) => entry.type === "blob" && entry.path)
        .map((entry) => entry.path as string);
    } catch {
      return "unknown";
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

    getDeltaFiles: async (
      repo: string,
      fromSha: string,
      toSha: string
    ): Promise<{ path: string; status: string }[] | "unknown"> => {
      const { owner, repo: name } = split(repo);

      try {
        const clientValue = await client();
        const { data } = await clientValue.request(
          "GET /repos/{owner}/{repo}/compare/{basehead}",
          { basehead: `${fromSha}...${toSha}`, owner, repo: name }
        );

        return (data.files ?? []).map((file) => ({
          path: file.filename,
          status: file.status ?? "modified",
        }));
      } catch {
        // Unreadable is not empty. The caller must not conclude "nothing
        // changed" from a failed read.
        return "unknown";
      }
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
      baseBranch: string,
      _ref: string,
      perRepoChecks?: string[],
      perRepoAppIds?: Record<string, number>
    ): Promise<RequiredChecksResult> => {
      const override = requiredChecksOverride();
      const platform = await readBranchProtection(client, repo, baseBranch);

      // Precedence, most specific first, and deliberately ADDITIVE:
      //   1. platform settings (branch protection) — the authority;
      //   2. the deployment-wide `FRONTIER_REQUIRED_CHECKS` operator override;
      //   3. the repository's own committed `required_checks`.
      //
      // A per-repo policy is only as trustworthy as write access to the default
      // branch, so it can require MORE than the platform but never less. It
      // cannot delete a platform requirement, and a platform `app_id` pin
      // always wins over a per-repo one.
      //
      // When the platform offers no protection (private repos on a plan
      // without it) there is nothing to be additive to, so the per-repo policy
      // is the only gate available. Honouring it there is an explicit operator
      // decision, because it is a trust channel equivalent to write access.
      const trustRepo = /^(1|true|yes)$/i.test(
        process.env.FRONTIER_TRUST_REPO_REQUIRED_CHECKS ?? ""
      );

      if (!platform.known) {
        if (perRepoChecks !== undefined && trustRepo) {
          return {
            appIds: perRepoAppIds ?? {},
            known: true,
            names: withoutSelfCheck(perRepoChecks),
          };
        }
        if (perRepoChecks !== undefined) {
          return {
            known: false,
            reason:
              "branch protection is unreadable and the repository's own " +
              "`required_checks` is not trusted for this deployment. Set " +
              "FRONTIER_TRUST_REPO_REQUIRED_CHECKS=1 to accept it as the " +
              "repository's policy, or grant the App 'administration: read'.",
          };
        }
        return platform;
      }

      if (override.length > 0) {
        return {
          appIds: platform.appIds ?? {},
          known: true,
          names: withoutSelfCheck([...override, ...(perRepoChecks ?? [])]),
        };
      }

      const names = withoutSelfCheck([
        ...platform.names,
        ...(perRepoChecks ?? []),
      ]);
      const appIds = { ...perRepoAppIds, ...platform.appIds };

      return { appIds, known: true, names };
    },

    listCheckRuns: async (
      repo: string,
      ref: string
    ): Promise<CheckRunView[]> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      // Paginate. A single capped page silently dropped required runs on a busy
      // head: the required name then matched nothing, `failed` and `pending`
      // were both empty, and the gate could conclude "CI green" from a list
      // that never contained the check it was looking for.
      const runs: {
        appId: number | undefined;
        conclusion: string | null;
        name: string;
        status: string;
      }[] = [];

      for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
        const response = await clientValue.request(
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          {
            filter: "latest",
            owner,
            page,
            per_page: MAX_CHECK_RUNS,
            ref,
            repo: name,
          }
        );

        const batch = response.data.check_runs ?? [];

        for (const run of batch) {
          runs.push({
            appId: run.app?.id,
            conclusion: run.conclusion,
            name: run.name,
            status: run.status,
          });
        }

        if (batch.length < MAX_CHECK_RUNS) {
          break;
        }
      }

      return runs;
    },

    listCommitStatuses: async (
      repo: string,
      ref: string
    ): Promise<CommitStatusView[]> => {
      const { owner, repo: name } = split(repo);
      const clientValue = await client();
      const { data } = await clientValue.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/status",
        { owner, per_page: MAX_CHECK_RUNS, ref, repo: name }
      );

      return (data.statuses ?? []).map((status) => ({
        context: status.context,
        state: status.state,
      }));
    },

    listRepoFiles,

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

    removeLabel: async (
      repo: string,
      prNumber: number,
      label: string
    ): Promise<void> => {
      const { owner, repo: name } = split(repo);

      try {
        const clientValue = await client();
        await clientValue.rest.issues.removeLabel({
          issue_number: prNumber,
          name: label,
          owner,
          repo: name,
        });
      } catch {
        // A label that is not applied is the desired end state, not a failure.
      }
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

      // Only reuse a run this App created. A same-named run from another App
      // must never be patched: doing so would rewrite someone else's check and
      // hide the fact that the gate has not reported on this commit.
      //
      // Fail closed when the App ID is unknown: without it there is no way to
      // tell our run from a stranger's, so reuse nothing and create a fresh run.
      // Name-only matching here is precisely the hole this closes.
      const ownAppId = Number(process.env.GITHUB_APP_ID);
      const previous = Number.isFinite(ownAppId)
        ? (existing.data.check_runs ?? []).find(
            (run) =>
              run.name === FRONTIER_CHECK_NAME && run.app?.id === ownAppId
          )
        : undefined;

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
