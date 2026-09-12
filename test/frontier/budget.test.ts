import { describe, expect, test } from "bun:test";

import {
  dayKey,
  monthKey,
  readSpend,
  reconcileBudget,
  reserveBudget,
} from "@/lib/frontier/budget";
import { createMemoryKv } from "@/lib/frontier/store";

const now = new Date("2026-09-12T12:00:00.000Z");
const limits = { dailyUsd: 5, maxCallUsd: 0.5, monthlyUsd: 50 };

interface Ledger {
  calls: number;
  costUsd: number;
}

const ledgerAt = (costUsd: number) => ({ calls: 1, costUsd });

const readLedger = async (
  kv: ReturnType<typeof createMemoryKv>,
  key: string
): Promise<Ledger | null> => await kv.get<Ledger>(key);

describe("reserveBudget", () => {
  test("allows a review that fits inside both ceilings", async () => {
    const kv = createMemoryKv();
    const decision = await reserveBudget(kv, now, limits, limits.maxCallUsd);

    expect(decision.allowed).toBe(true);
  });

  test("refuses when the remaining daily allowance cannot cover one review", async () => {
    const kv = createMemoryKv();
    await kv.set(dayKey(now), ledgerAt(4.9));

    const decision = await reserveBudget(kv, now, limits, limits.maxCallUsd);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("daily budget cannot cover one review");
  });

  test("refuses when the remaining monthly allowance cannot cover one review", async () => {
    const kv = createMemoryKv();
    await kv.set(monthKey(now), ledgerAt(49.8));

    const decision = await reserveBudget(kv, now, limits, limits.maxCallUsd);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("monthly budget cannot cover one review");
  });

  test("reserves the upper bound across both ledgers", async () => {
    const kv = createMemoryKv();
    await reserveBudget(kv, now, limits, limits.maxCallUsd);

    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 1,
      costUsd: limits.maxCallUsd,
    });
    expect(await readLedger(kv, monthKey(now))).toEqual({
      calls: 1,
      costUsd: limits.maxCallUsd,
    });
  });

  test("zero budget fails closed", async () => {
    const kv = createMemoryKv();
    const decision = await reserveBudget(
      kv,
      now,
      { dailyUsd: 0, maxCallUsd: 0, monthlyUsd: 0 },
      0
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("reconcileBudget", () => {
  test("replaces the reservation with the real cost", async () => {
    const kv = createMemoryKv();
    await reserveBudget(kv, now, limits, limits.maxCallUsd);
    await reconcileBudget(kv, now, limits.maxCallUsd, 0.02);

    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 1,
      costUsd: 0.02,
    });
    expect(await readLedger(kv, monthKey(now))).toEqual({
      calls: 1,
      costUsd: 0.02,
    });
  });

  test("keeps the reservation when the real cost is unknown", async () => {
    const kv = createMemoryKv();
    await reserveBudget(kv, now, limits, limits.maxCallUsd);

    const spend = await readSpend(kv, now);

    expect(spend.daily.costUsd).toBe(limits.maxCallUsd);
  });
});
