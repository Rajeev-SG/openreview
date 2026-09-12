import { describe, expect, test } from "bun:test";

import {
  createOpenRouterFrontierModel,
  FrontierModelError,
  parseFrontierResponse,
  reviewJsonSchema,
} from "@/lib/frontier/model";

import {
  alwaysBadPayloadFetch,
  alwaysFailingFetch,
  badPayloadThenValidFetch,
  captureFetch,
  transientThenSuccessFetch,
} from "./model-harness";

const review = {
  findings: [
    {
      category: "correctness",
      id: "F1",
      impact: "bad",
      line: 12,
      path: "lib/x.ts",
      problem: "p",
      required_fix: "f",
      severity: "P1",
      verification: "v",
    },
  ],
  summary: "s",
  verdict: "changes_required",
};

describe("parseFrontierResponse", () => {
  test("accepts a valid payload", () => {
    expect(parseFrontierResponse(review).findings).toHaveLength(1);
  });

  test("caps findings at five", () => {
    const parsed = parseFrontierResponse({
      ...review,
      findings: Array.from({ length: 9 }, (_v, index) => ({
        ...review.findings[0],
        id: `F${index}`,
      })),
    });
    expect(parsed.findings).toHaveLength(5);
  });

  test("coerces an empty changes_required verdict to a pass", () => {
    expect(
      parseFrontierResponse({
        findings: [],
        summary: "s",
        verdict: "changes_required",
      }).verdict
    ).toBe("pass");
  });

  test("rejects an invalid payload", () => {
    expect(() => parseFrontierResponse({ verdict: "maybe" })).toThrow();
  });

  test("drops findings without a required fix", () => {
    const parsed = parseFrontierResponse({
      ...review,
      findings: [{ ...review.findings[0], required_fix: "  " }],
    });
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.verdict).toBe("pass");
  });
});

describe("reviewJsonSchema", () => {
  test("is a strict object schema for structured output", () => {
    const schema = reviewJsonSchema() as {
      additionalProperties?: boolean;
      required?: string[];
      type?: string;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("verdict");
  });
});

describe("createOpenRouterFrontierModel", () => {
  test("pins model, reasoning, output cap, tools and reads exact cost", async () => {
    const { fetchImpl, request } = captureFetch({
      choices: [{ message: { content: JSON.stringify(review) } }],
      usage: { completion_tokens: 640, cost: 0.0125, prompt_tokens: 4200 },
    });

    const client = createOpenRouterFrontierModel({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await client.review({
      maxTokens: 3000,
      system: "judge",
      user: "packet",
    });

    const { payload } = request();
    expect(payload.model).toBe("z-ai/glm-5.3");
    expect(payload.max_tokens).toBe(3000);
    expect(payload.tools).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: "low", exclude: true });
    expect(payload.provider).toEqual({ require_parameters: true });
    expect(payload.usage).toEqual({ include: true });
    expect((payload.response_format as { type?: string }).type).toBe(
      "json_schema"
    );

    expect(result.usage).toEqual({
      costUsd: 0.0125,
      inputTokens: 4200,
      model: "z-ai/glm-5.3",
      outputTokens: 640,
    });
  });

  test("retries a transient failure at most once", async () => {
    const stub = transientThenSuccessFetch();
    const client = createOpenRouterFrontierModel({
      apiKey: "k",
      fetchImpl: stub.fetchImpl,
    });

    await client.review({ maxTokens: 10, system: "s", user: "u" });

    expect(stub.attempts()).toBe(2);
  });

  test("retries a schema-invalid payload and reports the summed cost", async () => {
    const stub = badPayloadThenValidFetch();
    const client = createOpenRouterFrontierModel({
      apiKey: "k",
      fetchImpl: stub.fetchImpl,
    });

    const result = await client.review({
      maxTokens: 10,
      system: "s",
      user: "u",
    });

    expect(stub.attempts()).toBe(2);
    // Both attempts were billed, so the reported cost covers both.
    expect(result.usage.costUsd).toBeCloseTo(0.008, 6);
    expect(result.usage.inputTokens).toBe(2000);
  });

  test("surfaces the billed spend when every attempt is unusable", async () => {
    const stub = alwaysBadPayloadFetch();
    const client = createOpenRouterFrontierModel({
      apiKey: "k",
      fetchImpl: stub.fetchImpl,
    });

    let caught: unknown = null;

    try {
      await client.review({ maxTokens: 10, system: "s", user: "u" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FrontierModelError);
    expect((caught as FrontierModelError).spentUsd).toBeCloseTo(0.008, 6);
  });

  test("does not retry a non-transient client error", async () => {
    const stub = alwaysFailingFetch(400);
    const client = createOpenRouterFrontierModel({
      apiKey: "k",
      fetchImpl: stub.fetchImpl,
    });

    await expect(
      client.review({ maxTokens: 10, system: "s", user: "u" })
    ).rejects.toThrow();

    expect(stub.attempts()).toBe(1);
  });
});
