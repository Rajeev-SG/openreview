import type { FrontierKv } from "@/lib/frontier/store";
import type {
  FrontierBudgetLimits,
  FrontierSpendEntry,
  FrontierSpendLedger,
} from "@/lib/frontier/types";

const EMPTY_LEDGER: FrontierSpendLedger = { calls: 0, costUsd: 0 };

export const dayKey = (now: Date): string =>
  `frontier:spend:day:${now.toISOString().slice(0, 10)}`;

export const monthKey = (now: Date): string =>
  `frontier:spend:month:${now.toISOString().slice(0, 7)}`;

export interface BudgetStatus {
  allowed: boolean;
  daily: FrontierSpendLedger;
  monthly: FrontierSpendLedger;
  reason?: string;
}

export const readSpend = async (
  kv: FrontierKv,
  now: Date
): Promise<{ daily: FrontierSpendLedger; monthly: FrontierSpendLedger }> => ({
  daily: (await kv.get<FrontierSpendLedger>(dayKey(now))) ?? EMPTY_LEDGER,
  monthly: (await kv.get<FrontierSpendLedger>(monthKey(now))) ?? EMPTY_LEDGER,
});

/**
 * Fail closed: if the ledger cannot be read we refuse to spend. Budgets of 0
 * mean "never spend".
 */
export const checkBudget = async (
  kv: FrontierKv,
  now: Date,
  limits: FrontierBudgetLimits
): Promise<BudgetStatus> => {
  let daily: FrontierSpendLedger;
  let monthly: FrontierSpendLedger;

  try {
    ({ daily, monthly } = await readSpend(kv, now));
  } catch (error) {
    return {
      allowed: false,
      daily: EMPTY_LEDGER,
      monthly: EMPTY_LEDGER,
      reason: `unable to read spend ledger: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (limits.dailyUsd <= 0 || limits.monthlyUsd <= 0) {
    return {
      allowed: false,
      daily,
      monthly,
      reason: "frontier budget disabled",
    };
  }

  if (daily.costUsd >= limits.dailyUsd) {
    return {
      allowed: false,
      daily,
      monthly,
      reason: `daily budget exhausted ($${daily.costUsd.toFixed(4)} >= $${limits.dailyUsd})`,
    };
  }

  if (monthly.costUsd >= limits.monthlyUsd) {
    return {
      allowed: false,
      daily,
      monthly,
      reason: `monthly budget exhausted ($${monthly.costUsd.toFixed(4)} >= $${limits.monthlyUsd})`,
    };
  }

  return { allowed: true, daily, monthly };
};

export const recordSpend = async (
  kv: FrontierKv,
  now: Date,
  entry: FrontierSpendEntry
): Promise<void> => {
  for (const key of [dayKey(now), monthKey(now)]) {
    const current = (await kv.get<FrontierSpendLedger>(key)) ?? EMPTY_LEDGER;
    await kv.set(key, {
      calls: current.calls + 1,
      costUsd: Number((current.costUsd + entry.costUsd).toFixed(6)),
    });
  }
};
