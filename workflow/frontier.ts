import { start } from "workflow/api";

import type { FrontierEvent, FrontierOutcome } from "@/lib/frontier/engine";

import { runFrontierEvent } from "./steps/run-frontier-event";

export const frontierWorkflow = async (
  event: FrontierEvent
): Promise<FrontierOutcome> => {
  "use workflow";

  const outcome = await runFrontierEvent(event);

  return outcome;
};

export const dispatchFrontierEvent = (event: FrontierEvent) =>
  start(frontierWorkflow, [event]);
