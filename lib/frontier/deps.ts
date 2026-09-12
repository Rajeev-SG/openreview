import "server-only";
import { getInstallationOctokit } from "@/lib/github";
import { getConnectedState, isDurableState } from "@/lib/state";

import {
  isFrontierEnabled,
  readFrontierBudget,
  readFrontierLimits,
  readFrontierModel,
} from "./config";
import type { FrontierEngineDeps } from "./engine";
import { createOpenRouterFrontierModel } from "./model";
import { createOctokitFrontierGitHub } from "./octokit";
import type { FrontierKv } from "./store";

export const createFrontierDeps = async (): Promise<FrontierEngineDeps> => {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  const durable = isDurableState();

  // Only connect a store we are actually going to use: with no durable store the
  // engine fails closed before touching it.
  const kv = durable
    ? ((await getConnectedState()) as FrontierKv)
    : ({} as FrontierKv);

  return {
    budget: readFrontierBudget(),
    github: createOctokitFrontierGitHub(getInstallationOctokit()),
    isDurableState: durable,
    kv,
    limits: readFrontierLimits(),
    log: (event, meta) => {
      console.info(`[frontier] ${event}`, meta ?? {});
    },
    model: createOpenRouterFrontierModel({
      apiKey,
      model: readFrontierModel(),
      referer: "https://github.com/Rajeev-SG/openreview",
      title: "OpenReview frontier quality gate",
    }),
  };
};

export const frontierEnabled = (): boolean => isFrontierEnabled();
