import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { planGitHubWebhook } from "@/lib/webhook-planner";

const SECRET = "webhook-secret";

const sign = (body: string): string =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

const headers = (init: Record<string, string>) => ({
  get: (name: string) => init[name.toLowerCase()] ?? null,
});

const plan = (eventName: string, payload: unknown) => {
  const rawBody = JSON.stringify(payload);
  return planGitHubWebhook({
    headers: headers({
      "x-github-delivery": "delivery-1",
      "x-github-event": eventName,
      "x-hub-signature-256": sign(rawBody),
    }),
    rawBody,
    secret: SECRET,
  });
};

const prPayload = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  pull_request: { draft: false, head: { sha: "head1" }, number: 7 },
  repository: { full_name: "acme/widgets" },
  ...extra,
});

describe("planGitHubWebhook — automatic frontier path", () => {
  test("routes PR lifecycle events to the frontier engine", () => {
    for (const action of [
      "opened",
      "reopened",
      "ready_for_review",
      "synchronize",
    ]) {
      const result = plan("pull_request", prPayload(action));
      expect(result.kind).toBe("frontier");
    }
  });

  test("routes required-check completion to the frontier engine", () => {
    const result = plan("check_run", {
      action: "completed",
      check_run: { conclusion: "success", name: "ci", status: "completed" },
      pull_request: { number: 7 },
      repository: { full_name: "acme/widgets" },
    });
    expect(result.kind).toBe("frontier");
  });

  test("ignores draft pull requests", () => {
    const result = plan("pull_request", {
      ...prPayload("opened"),
      pull_request: { draft: true, head: { sha: "h" }, number: 7 },
    });
    expect(result.kind).toBe("ignore");
  });

  test("routes only frontier labels, and ignores unrelated ones", () => {
    expect(
      plan("pull_request", {
        ...prPayload("labeled"),
        label: { name: "frontier-ready-final" },
      })
    ).toMatchObject({
      event: { kind: "label", label: "frontier-ready-final" },
      kind: "frontier",
    });

    expect(
      plan("pull_request", {
        ...prPayload("labeled"),
        label: { name: "documentation" },
      }).kind
    ).toBe("ignore");
  });
});

describe("planGitHubWebhook — safety", () => {
  test("rejects an invalid signature", () => {
    const rawBody = JSON.stringify(prPayload("opened"));
    const result = planGitHubWebhook({
      headers: headers({
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeef",
      }),
      rawBody,
      secret: SECRET,
    });
    expect(result.kind).toBe("ignore");
  });

  test("ignores ping deliveries", () => {
    expect(plan("ping", { zen: "hi" }).kind).toBe("ignore");
  });

  test("ignores malformed JSON", () => {
    const rawBody = "{not json";
    const result = planGitHubWebhook({
      headers: headers({
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(rawBody),
      }),
      rawBody,
      secret: SECRET,
    });
    expect(result.kind).toBe("ignore");
  });
});

describe("planGitHubWebhook — manual @openreview regression", () => {
  test("an issue_comment mention still goes to the Chat SDK adapter", () => {
    const result = plan("issue_comment", {
      action: "created",
      comment: { body: "@openreview please review this" },
      issue: { number: 7, pull_request: {} },
      repository: { full_name: "acme/widgets" },
    });
    expect(result.kind).toBe("chat");
  });

  test("a review comment reply still goes to the Chat SDK adapter", () => {
    const result = plan("pull_request_review_comment", {
      action: "created",
      comment: { body: "@openreview look again" },
      pull_request: { number: 7 },
      repository: { full_name: "acme/widgets" },
    });
    expect(result.kind).toBe("chat");
  });

  test("an issue_comment on a non-PR issue still goes to the Chat SDK adapter", () => {
    const result = plan("issue_comment", {
      action: "created",
      issue: { number: 3 },
      repository: { full_name: "acme/widgets" },
    });
    expect(result.kind).toBe("chat");
  });

  test("unrelated events still go to the Chat SDK adapter", () => {
    expect(plan("pull_request_review", { action: "submitted" }).kind).toBe(
      "chat"
    );
    expect(plan("reaction", { action: "created" }).kind).toBe("chat");
  });

  test("a chat-routed comment is never claimed as a frontier event", () => {
    // The manual path must not spend frontier tokens even if a comment mentions
    // the labels used by the automatic path.
    const result = plan("issue_comment", {
      action: "created",
      comment: { body: "please add frontier-ready-final" },
      issue: { number: 7, pull_request: {} },
      repository: { full_name: "acme/widgets" },
    });
    expect(result.kind).toBe("chat");
  });
});
