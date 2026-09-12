import { createFrontierDeps } from "@/lib/frontier/deps";
import { handleFrontierEvent } from "@/lib/frontier/engine";
import type { FrontierEvent, FrontierOutcome } from "@/lib/frontier/engine";

/**
 * Durable step for the automatic gate. The engine is internally idempotent
 * (delivery dedup, per-PR lock, paid-call idempotency), so a workflow-level
 * retry cannot duplicate spend.
 */
export const runFrontierEvent = async (
  event: FrontierEvent
): Promise<FrontierOutcome> => {
  "use step";

  const outcome = await handleFrontierEvent(createFrontierDeps(), event);

  return outcome;
};
