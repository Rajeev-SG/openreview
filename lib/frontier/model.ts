import { z } from "zod";

import {
  FRONTIER_MODEL,
  FRONTIER_REASONING_EFFORT,
} from "@/lib/frontier/config";
import type {
  FrontierFinding,
  FrontierReview,
  ModelUsage,
} from "@/lib/frontier/types";

export interface FrontierModelRequest {
  maxTokens: number;
  system: string;
  user: string;
}

export interface FrontierModelResponse {
  review: FrontierReview;
  usage: ModelUsage;
}

export interface FrontierModelClient {
  review: (request: FrontierModelRequest) => Promise<FrontierModelResponse>;
}

const nullableString = z.string().nullable();

const findingSchema = z.object({
  category: z.string(),
  id: z.string(),
  impact: z.string(),
  line: z.number().int().nullable(),
  path: nullableString,
  problem: z.string(),
  required_fix: z.string(),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  verification: z.string(),
});

const reviewSchema = z.object({
  findings: z.array(findingSchema),
  summary: z.string(),
  verdict: z.enum(["pass", "changes_required"]),
});

export const MAX_FINDINGS = 5;

export const FRONTIER_SYSTEM_PROMPT = `You are a frontier code-review judge. You do not edit code and you do not run commands.

Judge the whole solution, including where relevant:
- requirements/problem fit (a clean implementation of the wrong solution must fail)
- UX/operator workflow
- architecture/system design
- correctness
- integration/platform fit
- benchmark/evaluation validity
- reliability/operability
- security/privacy/blast radius
- cost/latency/token efficiency
- verification quality
- simplicity/maintainability

Return at most ${MAX_FINDINGS} materially consequential findings. Report no style nits, no generic praise, no diff restatement and no speculative refactor wish-lists. If nothing material is wrong, return verdict "pass" with an empty findings array.

Respond with only the structured JSON object described by the schema.`;

export const reviewJsonSchema = (): Record<string, unknown> => {
  const schema = z.toJSONSchema(reviewSchema, {
    io: "output",
    target: "draft-7",
  }) as Record<string, unknown>;

  delete schema.$schema;
  return schema;
};

const normalizeFinding = (
  finding: z.infer<typeof findingSchema>
): FrontierFinding => ({
  category: finding.category.trim(),
  id: finding.id.trim(),
  impact: finding.impact.trim(),
  ...(finding.line === null ? {} : { line: finding.line }),
  ...(finding.path === null || finding.path.trim() === ""
    ? {}
    : { path: finding.path.trim() }),
  problem: finding.problem.trim(),
  required_fix: finding.required_fix.trim(),
  severity: finding.severity,
  verification: finding.verification.trim(),
});

/**
 * Validate and bound a raw model response. Never trust the model: enforce the
 * schema, cap findings and coerce an empty `changes_required` verdict to a pass
 * (a "changes required" with nothing to change is a contradiction).
 */
export const parseFrontierResponse = (raw: unknown): FrontierReview => {
  const parsed = reviewSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `Frontier model returned an invalid review payload: ${parsed.error.message}`
    );
  }

  const findings = parsed.data.findings
    .filter(
      (finding) =>
        finding.problem.trim().length > 0 &&
        finding.required_fix.trim().length > 0 &&
        finding.impact.trim().length > 0
    )
    .slice(0, MAX_FINDINGS)
    .map(normalizeFinding);

  const verdict =
    parsed.data.verdict === "changes_required" && findings.length === 0
      ? "pass"
      : parsed.data.verdict;

  return {
    findings,
    summary: parsed.data.summary.trim(),
    verdict,
  };
};

const extractJson = (content: string): unknown => {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "");
  return JSON.parse(trimmed.trim());
};

const TRANSIENT_STATUS = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 522, 524,
]);

export interface OpenRouterFrontierOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  model?: string;
  referer?: string;
  title?: string;
}

interface OpenRouterChoice {
  message?: { content?: string | null };
}

interface OpenRouterUsage {
  completion_tokens?: number;
  cost?: number;
  prompt_tokens?: number;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string };
  usage?: OpenRouterUsage;
}

const readUsage = (
  usage: OpenRouterUsage | undefined,
  model: string
): ModelUsage => ({
  costUsd: typeof usage?.cost === "number" ? usage.cost : 0,
  inputTokens: usage?.prompt_tokens ?? 0,
  model,
  outputTokens: usage?.completion_tokens ?? 0,
});

/**
 * Direct, non-streaming OpenRouter call. Explicitly pinned: one model, low
 * reasoning, excluded reasoning tokens, provider parameter enforcement, capped
 * output, no tools, no automatic expensive-model fallback.
 */
export const createOpenRouterFrontierModel = (
  options: OpenRouterFrontierOptions
): FrontierModelClient => {
  const model = options.model ?? FRONTIER_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 2;

  return {
    review: async (
      request: FrontierModelRequest
    ): Promise<FrontierModelResponse> => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await doFetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              body: JSON.stringify({
                max_tokens: request.maxTokens,
                messages: [
                  { content: request.system, role: "system" },
                  { content: request.user, role: "user" },
                ],
                model,
                provider: { require_parameters: true },
                reasoning: {
                  effort: FRONTIER_REASONING_EFFORT,
                  exclude: true,
                },
                response_format: {
                  json_schema: {
                    name: "frontier_review",
                    schema: reviewJsonSchema(),
                    strict: true,
                  },
                  type: "json_schema",
                },
                usage: { include: true },
              }),
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                "Content-Type": "application/json",
                ...(options.referer ? { "HTTP-Referer": options.referer } : {}),
                ...(options.title ? { "X-Title": options.title } : {}),
              },
              method: "POST",
            }
          );

          if (!response.ok) {
            const body = await response.text();
            const error = new Error(
              `OpenRouter request failed (${response.status}): ${body.slice(0, 500)}`
            );

            if (
              TRANSIENT_STATUS.has(response.status) &&
              attempt < maxAttempts
            ) {
              lastError = error;
              continue;
            }

            throw error;
          }

          const data = (await response.json()) as OpenRouterResponse;

          if (data.error?.message) {
            throw new Error(`OpenRouter error: ${data.error.message}`);
          }

          const content = data.choices?.[0]?.message?.content;

          if (!content) {
            throw new Error("OpenRouter returned an empty completion");
          }

          return {
            review: parseFrontierResponse(extractJson(content)),
            usage: readUsage(data.usage, model),
          };
        } catch (error) {
          lastError = error;

          // Network/timeout errors are the only other retryable class.
          const isAbort = error instanceof Error && error.name === "AbortError";
          if (attempt < maxAttempts && isAbort) {
            continue;
          }

          throw error;
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("OpenRouter request failed after retries");
    },
  };
};
