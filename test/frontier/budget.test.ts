import { describe, expect, test } from "bun:test";

import {
  dayKey,
  monthKey,
  readSpend,
  reconcileBudget,
  reserveBudget,
} from "@/lib/frontier/budget";
import { createMemoryKv } from "@/lib/frontier/store";
import type { FrontierKv } from "@/lib/frontier/store";

const now = new Date("2026-09-12T12:00:00.000Z");
const limits = { dailyUsd: 100, maxCallUsd: 0.5, monthlyUsd: 1000 };

interface Ledger {
  calls: number;
  costUsd: number;
}

const readLedger = async (
  kv: FrontierKv,
  key: string
): Promise<Ledger | null> => await kv.get<Ledger>(key);

const locklessKv = (base: FrontierKv): FrontierKv => ({
  delete: base.delete,
  get: base.get,
  set: base.set,
});

describe("reserveBudget", () => {
  test("allows a review that fits inside both ceilings", async () => {
    const decision = await reserveBudget(createMemoryKv(), now, limits, 0.5);

    expect(decision.allowed).toBe(true);
    expect(typeof decision.reservationId).toBe("string");
  });

  test("refuses when the remaining daily allowance cannot cover one review", async () => {
    const kv = createMemoryKv();
    await kv.set(dayKey(now), { calls: 1, costUsd: 99.9 });

    const decision = await reserveBudget(kv, now, limits, 0.5);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("daily budget cannot cover one review");
  });

  test("refuses when the remaining monthly allowance cannot cover one review", async () => {
    const kv = createMemoryKv();
    await kv.set(monthKey(now), { calls: 1, costUsd: 999.8 });

    const decision = await reserveBudget(kv, now, limits, 0.5);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("monthly budget cannot cover one review");
  });

  test("reserves the upper bound across both ledgers", async () => {
    const kv = createMemoryKv();
    await reserveBudget(kv, now, limits, 0.5);

    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 1,
      costUsd: 0.5,
    });
    expect(await readLedger(kv, monthKey(now))).toEqual({
      calls: 1,
      costUsd: 0.5,
    });
  });

  test("refuses a zero reservation, which could not bound spend", async () => {
    const decision = await reserveBudget(createMemoryKv(), now, limits, 0);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("must be > 0");
  });

  test("zero budget fails closed", async () => {
    const decision = await reserveBudget(
      createMemoryKv(),
      now,
      { dailyUsd: 0, maxCallUsd: 0, monthlyUsd: 0 },
      0
    );

    expect(decision.allowed).toBe(false);
  });

  test("fails closed when the store cannot lock", async () => {
    const decision = await reserveBudget(
      locklessKv(createMemoryKv()),
      now,
      limits,
      0.5
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("locking");
  });
});

describe("reconcileBudget", () => {
  test("replaces the reservation with the real cost", async () => {
    const kv = createMemoryKv();
    const reserved = await reserveBudget(kv, now, limits, 0.5);

    const applied = await reconcileBudget(
      kv,
      now,
      reserved.reservationId,
      0.02
    );

    expect(applied).toBe(true);
    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 1,
      costUsd: 0.02,
    });
    expect(await readLedger(kv, monthKey(now))).toEqual({
      calls: 1,
      costUsd: 0.02,
    });
  });

  test("is idempotent for the same reservation", async () => {
    const kv = createMemoryKv();
    const reserved = await reserveBudget(kv, now, limits, 0.5);

    const first = await reconcileBudget(kv, now, reserved.reservationId, 0.02);
    const second = await reconcileBudget(kv, now, reserved.reservationId, 0.02);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 1,
      costUsd: 0.02,
    });
  });

  test("does not clobber a concurrent reservation", async () => {
    const kv = createMemoryKv();
    const first = await reserveBudget(kv, now, limits, 0.5);
    await reserveBudget(kv, now, limits, 0.5);

    await reconcileBudget(kv, now, first.reservationId, 0.02);

    expect(await readLedger(kv, dayKey(now))).toEqual({
      calls: 2,
      costUsd: 0.52,
    });
  });

  test("keeps the reservation when no identity is supplied", async () => {
    const kv = createMemoryKv();
    await reserveBudget(kv, now, limits, 0.5);

    const applied = await reconcileBudget(kv, now, undefined, 0.02);
    const spend = await readSpend(kv, now);

    expect(applied).toBe(false);
    expect(spend.daily.costUsd).toBe(0.5);
  });
});
