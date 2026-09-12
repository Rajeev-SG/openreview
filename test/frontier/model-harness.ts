import { yieldMicrotask } from "./harness";

const REVIEW_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          findings: [],
          summary: "ok",
          verdict: "pass",
        }),
      },
    },
  ],
  usage: { completion_tokens: 10, cost: 0.001, prompt_tokens: 100 },
};

export interface CapturedRequest {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export const captureFetch = (
  payload: unknown,
  status = 200
): { fetchImpl: typeof fetch; request: () => CapturedRequest } => {
  let captured: CapturedRequest = { headers: {}, payload: {} };

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    await yieldMicrotask();
    captured = {
      headers: init.headers as Record<string, string>,
      payload: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return Response.json(payload, { status });
  }) as unknown as typeof fetch;

  return { fetchImpl, request: () => captured };
};

/** Fails the first request with a transient status, then succeeds. */
export const transientThenSuccessFetch = (): {
  attempts: () => number;
  fetchImpl: typeof fetch;
} => {
  let calls = 0;

  const fetchImpl = (async () => {
    await yieldMicrotask();
    calls += 1;

    if (calls === 1) {
      return new Response("upstream boom", { status: 503 });
    }

    return Response.json(REVIEW_RESPONSE, { status: 200 });
  }) as unknown as typeof fetch;

  return { attempts: () => calls, fetchImpl };
};

/** Always responds with a non-transient client error. */
export const alwaysFailingFetch = (
  status = 400
): { attempts: () => number; fetchImpl: typeof fetch } => {
  let calls = 0;

  const fetchImpl = (async () => {
    await yieldMicrotask();
    calls += 1;
    return new Response("bad schema", { status });
  }) as unknown as typeof fetch;

  return { attempts: () => calls, fetchImpl };
};
