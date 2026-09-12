import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  experimental__runtimeEnv: {},
  server: {
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
    OPENREVIEW_MODEL: z.string().min(1).optional(),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    REDIS_URL: z.string().url().optional(),
  },
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
});
