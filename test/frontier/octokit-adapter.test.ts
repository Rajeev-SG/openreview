import { afterEach, describe, expect, test } from "bun:test";

import { createOctokitFrontierGitHub } from "@/lib/frontier/octokit";

/**
 * Adapter-level tests for the required-check precedence.
 *
 * These drive the real `octokit.ts` against a stubbed REST client, because the
 * in-memory `createFakeGitHub` re-implements the precedence it is used to test:
 * a divergence between the fake and the adapter (a typo in the plumb-through, a
 * flipped precedence) would leave every scenario test green.
 */

/** Wrap a stub in a resolved promise without a bare `.then`-style chain. */
const resolveClient = async (client: unknown): Promise<never> => {
  await Promise.resolve();
  return client as never;
};

/**
 * Build a request stub from a prefix→handler table. Branch-free by construction,
 * so test bodies stay assertions rather than control flow.
 */
const routeStub = (
  handlers: [string, () => unknown][],
  fallback: () => unknown
) => {
  const table = handlers.map(([prefix, handler]) => [prefix, handler] as const);

  return async (route: string): Promise<{ data: unknown }> => {
    await Promise.resolve();
    const match = table.find(([prefix]) => route.startsWith(prefix));
    return (match ? match[1]() : fallback()) as { data: unknown };
  };
};

const asyncNoop = async (): Promise<Record<string, never>> => {
  await Promise.resolve();
  return {};
};

interface StubCall {
  page?: number;
  route: string;
}

const makeClient = (options: {
  checkRuns?: { pages: Record<number, unknown[]> };
  protection?: unknown;
  protectionError?: { message: string; status: number };
}) => {
  const calls: StubCall[] = [];

  const request = (
    route: string,
    params: Record<string, unknown>
  ): Promise<{ data: unknown }> => {
    calls.push({ page: params.page as number | undefined, route });

    if (route.includes("protection/required_status_checks")) {
      if (options.protectionError) {
        const error = new Error(options.protectionError.message) as Error & {
          response: { data: { message: string } };
          status: number;
        };
        error.status = options.protectionError.status;
        error.response = { data: { message: options.protectionError.message } };
        return Promise.reject(error);
      }
      return Promise.resolve({
        data: options.protection ?? { checks: [], contexts: [] },
      });
    }

    if (route.includes("check-runs")) {
      const page = (params.page as number | undefined) ?? 1;
      const batch = options.checkRuns?.pages[page] ?? [];
      return Promise.resolve({ data: { check_runs: batch } });
    }

    if (route.includes("/status")) {
      return Promise.resolve({ data: { statuses: [] } });
    }

    return Promise.reject(new Error(`unexpected route ${route}`));
  };

  const client = {
    request,
    rest: {
      issues: { createComment: asyncNoop, removeLabel: asyncNoop },
    },
  };

  return { calls, client };
};

const adapter = (client: unknown) =>
  createOctokitFrontierGitHub(resolveClient(client));

const originalTrust = process.env.FRONTIER_TRUST_REPO_REQUIRED_CHECKS;
const originalAppId = process.env.GITHUB_APP_ID;

afterEach(() => {
  process.env.FRONTIER_TRUST_REPO_REQUIRED_CHECKS = originalTrust;
  process.env.GITHUB_APP_ID = originalAppId;
});

describe("octokit adapter — required-check precedence", () => {
  test("platform settings and a per-repo policy are additive", async () => {
    const { client } = makeClient({
      protection: {
        checks: [{ app_id: 15_368, context: "verify" }],
        contexts: [],
      },
    });

    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha",
      ["extra-lint"],
      { "extra-lint": 999 }
    );

    expect(result).toEqual({
      appIds: { "extra-lint": 999, verify: 15_368 },
      known: true,
      names: ["verify", "extra-lint"],
    });
  });

  test("a per-repo policy cannot delete a platform requirement", async () => {
    const { client } = makeClient({
      protection: {
        checks: [{ app_id: 15_368, context: "verify" }],
        contexts: [],
      },
    });

    // `required_checks: []` adds nothing; it does not clear `verify`.
    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha",
      []
    );

    expect(result).toEqual({
      appIds: { verify: 15_368 },
      known: true,
      names: ["verify"],
    });
  });

  test("a platform issuer pin wins over a per-repo pin", async () => {
    const { client } = makeClient({
      protection: {
        checks: [{ app_id: 15_368, context: "verify" }],
        contexts: [],
      },
    });

    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha",
      ["verify"],
      { verify: 999 }
    );

    expect(result).toMatchObject({ appIds: { verify: 15_368 } });
  });

  test("an unreadable platform plus an untrusted per-repo policy fails closed", async () => {
    process.env.FRONTIER_TRUST_REPO_REQUIRED_CHECKS = "";
    const { client } = makeClient({
      protectionError: {
        message: "Resource not accessible by integration",
        status: 403,
      },
    });

    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha",
      ["verify"]
    );

    expect(result.known).toBe(false);
  });

  test("an explicit operator opt-in honours the per-repo policy when the platform offers none", async () => {
    process.env.FRONTIER_TRUST_REPO_REQUIRED_CHECKS = "1";
    const { client } = makeClient({
      protectionError: {
        message: "Upgrade to GitHub Pro or make this repository public",
        status: 403,
      },
    });

    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha",
      ["verify"],
      { verify: 15_368 }
    );

    expect(result).toEqual({
      appIds: { verify: 15_368 },
      known: true,
      names: ["verify"],
    });
  });

  test("a legacy status-only context is reported as unknown, not as a wait", async () => {
    const { client } = makeClient({
      protection: { checks: [], contexts: ["ci/status"] },
    });

    const result = await adapter(client).getRequiredChecks(
      "o/r",
      "main",
      "sha"
    );

    expect(result.known).toBe(false);
  });

  test("check runs are paged so a required run cannot hide behind the cap", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      app: { id: 1 },
      conclusion: "success",
      name: `filler-${i}`,
      status: "completed",
    }));
    const { calls, client } = makeClient({
      checkRuns: {
        pages: {
          1: full,
          2: [
            {
              app: { id: 15_368 },
              conclusion: "success",
              name: "verify",
              status: "completed",
            },
          ],
        },
      },
    });

    const runs = await adapter(client).listCheckRuns("o/r", "sha");

    expect(calls.some((call) => call.page === 2)).toBe(true);
    expect(runs.map((run) => run.name)).toContain("verify");
  });
});

describe("octokit adapter — self-check issuer binding", () => {
  test("with no GITHUB_APP_ID the adapter creates a fresh run rather than reusing a foreign one", async () => {
    const patches: string[] = [];
    const posts: string[] = [];

    const client = {
      request: routeStub(
        [
          [
            "PATCH",
            () => {
              patches.push("PATCH");
              return { data: { id: 1 } };
            },
          ],
          [
            "POST",
            () => {
              posts.push("POST");
              return { data: { id: 7 } };
            },
          ],
        ],
        () => ({
          data: {
            check_runs: [
              { app: { id: 999_999 }, id: 42, name: "frontier-quality" },
            ],
          },
        })
      ),
    };

    process.env.GITHUB_APP_ID = "";

    const id = await adapter(client).setFrontierCheck({
      conclusion: "success",
      headSha: "sha",
      name: "frontier-quality",
      prNumber: 1,
      repo: "o/r",
      status: "completed",
      summary: "s",
      title: "t",
    });

    expect(patches).toHaveLength(0);
    expect(id).toBe(7);
  });

  test("with a matching GITHUB_APP_ID the adapter reuses its own run", async () => {
    const patches: string[] = [];

    const client = {
      request: routeStub(
        [
          [
            "PATCH",
            () => {
              patches.push("PATCH");
              return { data: { id: 42 } };
            },
          ],
        ],
        () => ({
          data: {
            check_runs: [
              { app: { id: 3_141_537 }, id: 42, name: "frontier-quality" },
            ],
          },
        })
      ),
    };

    process.env.GITHUB_APP_ID = "3141537";

    const id = await adapter(client).setFrontierCheck({
      conclusion: "success",
      headSha: "sha",
      name: "frontier-quality",
      prNumber: 1,
      repo: "o/r",
      status: "completed",
      summary: "s",
      title: "t",
    });

    expect(patches).toHaveLength(1);
    expect(id).toBe(42);
  });
});
