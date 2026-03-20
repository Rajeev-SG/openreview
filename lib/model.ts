import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { CompatibleLanguageModel } from "@workflow/ai/agent";

import { env } from "@/lib/env";

const DEFAULT_OPENREVIEW_MODEL = "anthropic/claude-sonnet-4.6";

export const getOpenReviewModel = () =>
  env.OPENREVIEW_MODEL ?? DEFAULT_OPENREVIEW_MODEL;

export const getAgentModel = () => {
  const model = getOpenReviewModel();

  if (env.OPENROUTER_API_KEY) {
    return (): Promise<CompatibleLanguageModel> => {
      const openrouter = createOpenAICompatible({
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        name: "openrouter",
      });

      return Promise.resolve(
        openrouter(model) as unknown as CompatibleLanguageModel
      );
    };
  }

  if (env.ANTHROPIC_API_KEY) {
    if (!model.startsWith("anthropic/")) {
      throw new Error(
        `OPENREVIEW_MODEL must use an anthropic/* model when falling back to ANTHROPIC_API_KEY. Received "${model}".`
      );
    }

    return model;
  }

  throw new Error(
    "Missing AI provider configuration. Set OPENROUTER_API_KEY to use OpenRouter, or ANTHROPIC_API_KEY for Anthropic fallback."
  );
};
