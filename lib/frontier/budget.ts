import { randomUUID } from "node:crypto";

import type { FrontierKv } from "@/lib/frontier/store";
import type {
  FrontierBudgetLimits,
  FrontierSpendEntry,
  FrontierSpendLedger,
} from "@/lib/frontier/types";

const EMPTY_LEDGER: FrontierSpendLedger = { calls: 0, costUsd: 0 };
const SPEND_LOCK_KEY = "frontier:lock:spend";
const SPEND_LOCK_TTL_MS = 30_000;
const RESERVATION_TTL_MS = 45 * 24 * 60 * 60 * 1000;

export const dayKey = (now: Date): string =>
  `frontier:spend:day:${now.toISOString().slice(0, 10)}`;

export const monthKey = (now: Date): string =>
  `frontier:spend:month:${now.toISOString().slice(0, 7)}`;

export const reservationKey = (reservationId: string): string =>
  `frontier:reservation:${reservationId}`;

const round6 = (value: number): number => Number(value.toFixed(6));

/**
 * Worst-case characters per token. A token cannot be shorter than one
 * character, so dividing by 1 is the only defensible upper bound for the input
 * tokens a permitted packet can produce. Anything denser would under-reserve on
 * punctuation-heavy, code-heavy or non-English content.
 */
const CHARS_PER_TOKEN_FLOOR = 1;
/** Headroom for the system prompt and schema, which are not in the packet. */
const SYSTEM_PROMPT_TOKENS = 2000;

export interface ReservationInput {
  inputUsdPerMTok: number;
  maxOutputTokens: number;
  maxPacketChars: number;
  outputUsdPerMTok: number;
}

/**
 * Analytic upper bound for one review: the largest packet the caps allow, at
 * the configured price, plus the full output cap. `maxCallUsd` remains a floor
 * so an operator can only make the reservation more conservative.
 */
export const deriveReservationUsd = (
  input: ReservationInput,
  floorUsd: number
): number => {
  const inputTokens =
    Math.ceil(input.maxPacketChars / CHARS_PER_TOKEN_FLOOR) +
    SYSTEM_PROMPT_TOKENS;
  const derived =
    (inputTokens * input.inputUsdPerMTok +
      input.maxOutputTokens * input.outputUsdPerMTok) /
    1_000_000;

  return Math.max(floorUsd, round6(derived));
};

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
  reservationId?: string;
}

interface Reservation {
  createdAt: string;
  reserveUsd: number;
}

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
 * Serialise every ledger mutation. The daily and monthly keys are shared across
 * PRs, so the per-PR lock is not enough: without this, concurrent reviews (and
 * reconciliations) could lose increments and overshoot the ceiling.
 *
 * A store without distributed locking cannot make that guarantee, so this fails
 * closed rather than pretending to be safe.
 */
const withSpendLock = async <T>(
  kv: FrontierKv,
  task: () => Promise<T>
): Promise<T> => {
  if (!(kv.acquireLock && kv.releaseLock)) {
    throw new Error("state store does not support locking");
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
 * when the ledger cannot be read, when locking is unavailable, or when the
 * remaining allowance cannot cover the reservation.
 */
export const reserveBudget = async (
  kv: FrontierKv,
  now: Date,
  limits: FrontierBudgetLimits,
  reserveUsd: number
): Promise<BudgetDecision> => {
  if (limits.dailyUsd <= 0 || limits.monthlyUsd <= 0) {
    return { allowed: false, reason: "frontier budget disabled" };
  }

  if (!(reserveUsd > 0)) {
    return {
      allowed: false,
      reason:
        "FRONTIER_MAX_CALL_USD must be > 0: a zero reservation cannot bound spend",
    };
  }

  const daily = dayKey(now);
  const monthly = monthKey(now);
  const reservationId = randomUUID();

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
      await kv.set(
        reservationKey(reservationId),
        {
          createdAt: now.toISOString(),
          reserveUsd,
        } satisfies Reservation,
        RESERVATION_TTL_MS
      );

      return { allowed: true, reservationId };
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
 * Replace a reservation with the actual billed cost. Idempotent: the
 * reservation record is the reservation's identity, and it is deleted once
 * applied, so a repeated or retried reconciliation is a no-op rather than a
 * double adjustment. Callers that cannot determine the real cost must not
 * reconcile, which leaves the reservation in place (conservative).
 */
export const reconcileBudget = async (
  kv: FrontierKv,
  now: Date,
  reservationId: string | undefined,
  actualUsd: number
): Promise<boolean> => {
  if (!reservationId) {
    return false;
  }

  const key = reservationKey(reservationId);

  return await withSpendLock(kv, async () => {
    const reservation = await kv.get<Reservation>(key);

    if (!reservation) {
      return false;
    }

    // Claim the reservation before adjusting, so an interrupted reconciliation
    // can never be retried into a second adjustment. A partial failure leaves
    // the ledger over-counted (the reservation), never under-counted.
    await kv.delete(key);

    const delta = actualUsd - reservation.reserveUsd;

    if (delta !== 0) {
      for (const ledgerKey of [dayKey(now), monthKey(now)]) {
        const ledger = await readLedger(kv, ledgerKey);
        await writeLedger(kv, ledgerKey, adjust(ledger, delta, 0));
      }
    }

    return true;
  });
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
