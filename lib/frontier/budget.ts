import type { FrontierKv } from "@/lib/frontier/store";
import type {
  FrontierBudgetLimits,
  FrontierSpendEntry,
  FrontierSpendLedger,
} from "@/lib/frontier/types";

const EMPTY_LEDGER: FrontierSpendLedger = { calls: 0, costUsd: 0 };
const SPEND_LOCK_KEY = "frontier:lock:spend";
const SPEND_LOCK_TTL_MS = 30_000;

export const dayKey = (now: Date): string =>
  `frontier:spend:day:${now.toISOString().slice(0, 10)}`;

export const monthKey = (now: Date): string =>
  `frontier:spend:month:${now.toISOString().slice(0, 7)}`;

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

const round6 = (value: number): number => Number(value.toFixed(6));

const readLedger = async (
  kv: FrontierKv,
  key: string
): Promise<FrontierSpendLedger> =>
  (await kv.get<FrontierSpendLedger>(key)) ?? EMPTY_LEDGER;

const writeLedger = async (
  kv: FrontierKv,
  key: string,
  ledger: FrontierSpendLedger
): Promise<void> => {
  await kv.set(key, { calls: ledger.calls, costUsd: round6(ledger.costUsd) });
};

/**
 * Serialise ledger mutations. Daily and monthly keys are shared across PRs, so
 * the per-PR lock is not enough: without this, concurrent reviews can lose
 * increments and overshoot the ceiling.
 */
const withSpendLock = async <T>(
  kv: FrontierKv,
  task: () => Promise<T>
): Promise<T> => {
  if (!(kv.acquireLock && kv.releaseLock)) {
    return task();
  }

  const lock = await kv.acquireLock(SPEND_LOCK_KEY, SPEND_LOCK_TTL_MS);

  if (!lock) {
    throw new Error("could not acquire the frontier spend lock");
  }

  try {
    return await task();
  } finally {
    await kv.releaseLock(lock);
  }
};

const adjust = (
  ledger: FrontierSpendLedger,
  delta: number,
  calls: number
): FrontierSpendLedger => ({
  calls: ledger.calls + calls,
  costUsd: Math.max(0, ledger.costUsd + delta),
});

/**
 * Reserve a conservative upper bound for one review **before** it runs, so the
 * configured ceilings are hard spend bounds rather than advisory. Fails closed
 * when the ledger cannot be read or the remaining allowance cannot cover the
 * reservation.
 */
export const reserveBudget = async (
  kv: FrontierKv,
  now: Date,
  limits: FrontierBudgetLimits,
  reserveUsd: number
): Promise<BudgetDecision> => {
  const daily = dayKey(now);
  const monthly = monthKey(now);

  if (limits.dailyUsd <= 0 || limits.monthlyUsd <= 0) {
    return { allowed: false, reason: "frontier budget disabled" };
  }

  try {
    return await withSpendLock(kv, async () => {
      const dailyLedger = await readLedger(kv, daily);
      const monthlyLedger = await readLedger(kv, monthly);

      if (dailyLedger.costUsd + reserveUsd >= limits.dailyUsd) {
        return {
          allowed: false,
          reason: `daily budget cannot cover one review ($${dailyLedger.costUsd.toFixed(4)} spent + $${reserveUsd} reserve >= $${limits.dailyUsd})`,
        };
      }

      if (monthlyLedger.costUsd + reserveUsd >= limits.monthlyUsd) {
        return {
          allowed: false,
          reason: `monthly budget cannot cover one review ($${monthlyLedger.costUsd.toFixed(4)} spent + $${reserveUsd} reserve >= $${limits.monthlyUsd})`,
        };
      }

      await writeLedger(kv, daily, adjust(dailyLedger, reserveUsd, 1));
      await writeLedger(kv, monthly, adjust(monthlyLedger, reserveUsd, 1));

      return { allowed: true };
    });
  } catch (error) {
    return {
      allowed: false,
      reason: `unable to read or reserve the spend ledger: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

/**
 * Replace a reservation with the actual billed cost. Callers that cannot
 * determine the real cost must keep the reservation (conservative).
 */
export const reconcileBudget = async (
  kv: FrontierKv,
  now: Date,
  reserveUsd: number,
  actualUsd: number
): Promise<void> => {
  const delta = actualUsd - reserveUsd;

  if (delta === 0) {
    return;
  }

  for (const key of [dayKey(now), monthKey(now)]) {
    const ledger = await readLedger(kv, key);
    await writeLedger(kv, key, adjust(ledger, delta, 0));
  }
};

/** Telemetry record for one paid review. The ledger is reserved/reconciled. */
export const describeSpend = (
  entry: FrontierSpendEntry
): Record<string, unknown> => ({
  costUsd: entry.costUsd,
  inputTokens: entry.inputTokens,
  model: entry.model,
  outputTokens: entry.outputTokens,
  reviewNumber: entry.reviewNumber,
  timestamp: entry.timestamp,
});

export const readSpend = async (
  kv: FrontierKv,
  now: Date
): Promise<{ daily: FrontierSpendLedger; monthly: FrontierSpendLedger }> => ({
  daily: await readLedger(kv, dayKey(now)),
  monthly: await readLedger(kv, monthKey(now)),
});
