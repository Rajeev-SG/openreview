import { createHmac, timingSafeEqual } from "node:crypto";

import type { FrontierEvent } from "@/lib/frontier/engine";
import {
  FINAL_SIGNAL_LABEL,
  FORCE_REVIEW_LABEL,
  NEW_CYCLE_LABEL,
} from "@/lib/frontier/types";

export type WebhookPlan =
  | { event: FrontierEvent; kind: "frontier" }
  | { kind: "chat" }
  | { kind: "ignore"; reason: string };

export interface WebhookPlanInput {
  headers: { get: (name: string) => string | null };
  rawBody: string;
  secret: string;
}

const FRONTIER_LABELS = new Set([
  FINAL_SIGNAL_LABEL,
  FORCE_REVIEW_LABEL,
  NEW_CYCLE_LABEL,
]);

const PR_ACTIONS = new Set([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

export const verifySignature = (input: {
  rawBody: string;
  secret: string;
  signature: string | null;
}): boolean => {
  if (!input.signature || !input.secret) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(input.signature), Buffer.from(expected));
  } catch {
    return false;
  }
};

interface MinimalPayload {
  action?: string;
  check_run?: { conclusion?: string | null; name?: string; status?: string };
  installation?: { id?: number };
  label?: { name?: string };
  pull_request?: { draft?: boolean; head?: { sha?: string }; number?: number };
  repository?: { full_name?: string };
}

const buildEvent = (
  kind: FrontierEvent["kind"],
  action: string,
  payload: MinimalPayload,
  deliveryId: string | undefined
): FrontierEvent | null => {
  const repo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;

  if (!repo || !prNumber) {
    return null;
  }

  const headSha = payload.pull_request?.head?.sha;

  return {
    action,
    deliveryId,
    ...(headSha ? { headSha } : {}),
    kind,
    prNumber,
    repo,
  };
};

const planPullRequestEvent = (
  eventName: string | null,
  action: string,
  payload: MinimalPayload,
  deliveryId: string | undefined
): WebhookPlan | null => {
  if (eventName !== "pull_request") {
    return null;
  }

  if (PR_ACTIONS.has(action)) {
    const event = buildEvent("pull_request", action, payload, deliveryId);

    if (!event) {
      return { kind: "ignore", reason: "missing repository or pull request" };
    }

    // Draft PRs never spend frontier tokens.
    if (payload.pull_request?.draft) {
      return { kind: "ignore", reason: "draft pull request" };
    }

    return { event, kind: "frontier" };
  }

  if (action === "labeled") {
    const label = payload.label?.name ?? "";

    if (!FRONTIER_LABELS.has(label)) {
      return { kind: "ignore", reason: `unrelated label: ${label}` };
    }

    const event = buildEvent("label", action, payload, deliveryId);

    return event ? { event: { ...event, label }, kind: "frontier" } : null;
  }

  return null;
};

const planCheckRunEvent = (
  eventName: string | null,
  payload: MinimalPayload,
  deliveryId: string | undefined
): WebhookPlan | null => {
  if (eventName !== "check_run" || payload.check_run?.status !== "completed") {
    return null;
  }

  const event = buildEvent(
    "check_run",
    payload.action ?? "",
    payload,
    deliveryId
  );

  return event ? { event, kind: "frontier" } : null;
};

/**
 * Pure routing decision for an incoming GitHub webhook.
 *
 * The automatic frontier path only claims the events it needs; everything else
 * (notably `issue_comment` mentions and reactions) continues to the existing
 * Chat SDK `@openreview` adapter untouched.
 */
export const planGitHubWebhook = (input: WebhookPlanInput): WebhookPlan => {
  const eventName = input.headers.get("x-github-event");
  const signature = input.headers.get("x-hub-signature-256");
  const deliveryId = input.headers.get("x-github-delivery") ?? undefined;

  if (eventName === "ping") {
    return { kind: "ignore", reason: "ping" };
  }

  if (
    !verifySignature({
      rawBody: input.rawBody,
      secret: input.secret,
      signature,
    })
  ) {
    return { kind: "ignore", reason: "invalid signature" };
  }

  let payload: MinimalPayload;

  try {
    payload = JSON.parse(input.rawBody) as MinimalPayload;
  } catch {
    return { kind: "ignore", reason: "invalid JSON" };
  }

  const action = payload.action ?? "";

  return (
    planPullRequestEvent(eventName, action, payload, deliveryId) ??
    planCheckRunEvent(eventName, payload, deliveryId) ?? { kind: "chat" }
  );
};
