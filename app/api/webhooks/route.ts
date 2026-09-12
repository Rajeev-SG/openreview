import { after, NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getBot } from "@/lib/bot";
import { env } from "@/lib/env";
import { frontierEnabled } from "@/lib/frontier/deps";
import { planGitHubWebhook } from "@/lib/webhook-planner";
import { dispatchFrontierEvent } from "@/workflow/frontier";

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const rawBody = await request.text();
  const plan = planGitHubWebhook({
    headers: request.headers,
    rawBody,
    secret: env.GITHUB_APP_WEBHOOK_SECRET ?? "",
  });

  if (plan.kind === "ignore") {
    return NextResponse.json({ ignored: plan.reason, ok: true });
  }

  if (plan.kind === "frontier") {
    if (!frontierEnabled()) {
      return NextResponse.json({ ok: true, skipped: "frontier disabled" });
    }

    await dispatchFrontierEvent(plan.event);

    return NextResponse.json({ ok: true, queued: true });
  }

  // Manual `@openreview` (mentions, replies, reactions) keeps using the
  // existing Chat SDK adapter. The body was consumed above, so replay it.
  const bot = await getBot();
  const handler = bot.webhooks.github;

  if (!handler) {
    return NextResponse.json(
      { error: "GitHub adapter not configured" },
      { status: 404 }
    );
  }

  const replay = new Request(request.url, {
    body: rawBody,
    headers: request.headers,
    method: "POST",
  });

  return handler(replay, {
    waitUntil: (task) => after(() => task),
  }) as Promise<NextResponse>;
};
