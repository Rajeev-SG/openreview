import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import { ConsoleLogger } from "chat";
import type { StateAdapter } from "chat";

import { env } from "@/lib/env";

/**
 * One shared state adapter for the whole deployment: the manual `@openreview`
 * Chat SDK path and the automatic frontier gate both persist here.
 */
export const stateAdapter: StateAdapter = env.REDIS_URL
  ? createRedisState({ logger: new ConsoleLogger(), url: env.REDIS_URL })
  : createMemoryState();

export const isDurableState = (): boolean => Boolean(env.REDIS_URL);
