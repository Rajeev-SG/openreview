import { start } from "workflow/api";

import { createFrontierDeps } from "@/lib/frontier/deps";
import type { FrontierEvent, FrontierOutcome } from "@/lib/frontier/engine";
import { handleFrontierEvent } from "@/lib/frontier/engine";

/**
 * Durable wrapper for the automatic gate. One step is enough: the engine is
 * internally idempotent (delivery dedup, per-PR lock, paid-call idempotency),
 * so a workflow-level retry cannot duplicate spend.
 */
export const runFrontierEvent = async (
  event: FrontierEvent
): Promise<FrontierOutcome> => {
  const outcome = await handleFrontierEvent(createFrontierDeps(), event);

  return outcome;
};

export const frontierWorkflow = async (
  event: FrontierEvent
): Promise<FrontierOutcome> => {
  const outcome = await runFrontierEvent(event);

  return outcome;
};

export const dispatchFrontierEvent = (event: FrontierEvent) =>
  start(frontierWorkflow, [event]);
