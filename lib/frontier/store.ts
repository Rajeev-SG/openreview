import { createMemoryState } from "@chat-adapter/state-memory";

import type { FrontierPrState } from "@/lib/frontier/types";

export type FrontierLockHandle = unknown;

/**
 * Narrow durable KV surface. The existing chat `StateAdapter` (Redis in
 * production, memory in tests) already satisfies it, so the gate needs no new
 * storage dependency.
 */
export interface FrontierKv {
  // Method syntax keeps these bivariant, so the existing chat `StateAdapter`
  // satisfies this interface without an adapter shim.
  acquireLock?(key: string, ttlMs: number): Promise<FrontierLockHandle | null>;
  delete(key: string): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  releaseLock?(handle: FrontierLockHandle): Promise<void>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const STATE_TTL_MS = 45 * DAY_MS;
export const DELIVERY_TTL_MS = 14 * DAY_MS;
export const IDEMPOTENCY_TTL_MS = 45 * DAY_MS;

export const prStateKey = (repo: string, prNumber: number): string =>
  `frontier:pr:${repo}#${prNumber}`;

export const deliveryKey = (deliveryId: string): string =>
  `frontier:delivery:${deliveryId}`;

export const idempotencyKey = (input: {
  cycleId: number;
  packetHash: string;
  prNumber: number;
  repo: string;
  reviewNumber: number;
  reviewedSha: string;
}): string =>
  [
    "frontier:idem",
    input.repo,
    `pr${input.prNumber}`,
    `c${input.cycleId}`,
    `r${input.reviewNumber}`,
    input.reviewedSha,
    input.packetHash,
  ].join(":");

export const loadPrState = (
  kv: FrontierKv,
  repo: string,
  prNumber: number
): Promise<FrontierPrState | null> =>
  kv.get<FrontierPrState>(prStateKey(repo, prNumber));

export const savePrState = async (
  kv: FrontierKv,
  state: FrontierPrState,
  now: Date
): Promise<void> => {
  await kv.set(
    prStateKey(state.repo, state.prNumber),
    { ...state, updatedAt: now.toISOString() },
    STATE_TTL_MS
  );
};

export const createInitialState = (input: {
  headSha: string;
  now: Date;
  prNumber: number;
  repo: string;
}): FrontierPrState => ({
  cycleId: 1,
  headSha: input.headSha,
  lifecycle: "idle",
  packetHashes: [],
  prNumber: input.prNumber,
  repo: input.repo,
  reviewCount: 0,
  reviews: [],
  updatedAt: input.now.toISOString(),
  version: 1,
});

/**
 * In-memory KV for tests and local runs. Reuses the existing chat memory state
 * adapter (which requires an explicit connect) rather than hand-rolling a
 * second implementation.
 */
export const createMemoryKv = (): FrontierKv => {
  const adapter = createMemoryState();

  return {
    acquireLock: async (key, ttlMs) => {
      await adapter.connect();
      return adapter.acquireLock(key, ttlMs);
    },
    delete: async (key) => {
      await adapter.connect();
      await adapter.delete(key);
    },
    get: async <T = unknown>(key: string) => {
      await adapter.connect();
      return (await adapter.get(key)) as T | null;
    },
    releaseLock: async (handle) => {
      await adapter.connect();
      await adapter.releaseLock(
        handle as Parameters<typeof adapter.releaseLock>[0]
      );
    },
    set: async <T = unknown>(key: string, value: T, ttlMs?: number) => {
      await adapter.connect();
      await adapter.set(key, value, ttlMs);
    },
  };
};
