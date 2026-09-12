import "server-only";
import { getInstallationOctokit } from "@/lib/github";
import { stateAdapter } from "@/lib/state";

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

export const createFrontierDeps = (): FrontierEngineDeps => {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";

  return {
    budget: readFrontierBudget(),
    github: createOctokitFrontierGitHub(getInstallationOctokit()),
    kv: stateAdapter as FrontierKv,
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
