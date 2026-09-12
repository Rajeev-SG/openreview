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

let connectPromise: Promise<void> | null = null;

/**
 * The adapter requires an explicit connect (the Chat SDK does this itself when
 * it initialises the bot). The frontier step can run without the bot being
 * initialised, so it connects on demand. Connecting twice is a no-op.
 */
export const getConnectedState = async (): Promise<StateAdapter> => {
  if (!connectPromise) {
    connectPromise = stateAdapter.connect();
  }

  try {
    await connectPromise;
  } catch (error) {
    connectPromise = null;
    throw error;
  }

  return stateAdapter;
};

export const isDurableState = (): boolean => Boolean(env.REDIS_URL);
