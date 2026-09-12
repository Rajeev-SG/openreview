import { describe, expect, test } from "bun:test";

import {
  checkBudget,
  dayKey,
  monthKey,
  recordSpend,
} from "@/lib/frontier/budget";
import { createMemoryKv } from "@/lib/frontier/store";

const now = new Date("2026-09-12T12:00:00.000Z");

describe("budget guard", () => {
  test("allows spend within budget", async () => {
    const kv = createMemoryKv();
    const status = await checkBudget(kv, now, { dailyUsd: 5, monthlyUsd: 50 });
    expect(status.allowed).toBe(true);
  });

  test("refuses once the daily budget is reached", async () => {
    const kv = createMemoryKv();
    await kv.set(dayKey(now), { calls: 1, costUsd: 3 });
    const status = await checkBudget(kv, now, { dailyUsd: 3, monthlyUsd: 50 });
    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("daily budget");
  });

  test("refuses once the monthly budget is reached", async () => {
    const kv = createMemoryKv();
    await kv.set(monthKey(now), { calls: 9, costUsd: 12 });
    const status = await checkBudget(kv, now, {
      dailyUsd: 100,
      monthlyUsd: 12,
    });
    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("monthly budget");
  });

  test("zero budget fails closed", async () => {
    const kv = createMemoryKv();
    const status = await checkBudget(kv, now, { dailyUsd: 0, monthlyUsd: 0 });
    expect(status.allowed).toBe(false);
  });

  test("recordSpend updates both ledgers", async () => {
    const kv = createMemoryKv();
    await recordSpend(kv, now, {
      costUsd: 0.25,
      inputTokens: 100,
      model: "m",
      outputTokens: 10,
      prNumber: 1,
      repo: "a/b",
      reviewNumber: 1,
      timestamp: now.toISOString(),
    });
    await recordSpend(kv, now, {
      costUsd: 0.25,
      inputTokens: 100,
      model: "m",
      outputTokens: 10,
      prNumber: 1,
      repo: "a/b",
      reviewNumber: 2,
      timestamp: now.toISOString(),
    });

    const daily = await kv.get<{ calls: number; costUsd: number }>(dayKey(now));
    const monthly = await kv.get<{ calls: number; costUsd: number }>(
      monthKey(now)
    );

    expect(daily).toEqual({ calls: 2, costUsd: 0.5 });
    expect(monthly).toEqual({ calls: 2, costUsd: 0.5 });
  });
});
