import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";

import { createAgent } from "@/lib/agent";
import { parseError } from "@/lib/error";
import type { ThreadMessage } from "@/workflow";

import { discoverSkills } from "./discover-skills";
import { startTyping } from "./start-typing";

export interface AgentResult {
  errorMessage?: string;
  success: boolean;
}

export const runAgent = async (
  sandboxId: string,
  threadMessages: ThreadMessage[],
  threadId: string,
  prNumber: number,
  repoFullName: string
): Promise<AgentResult> => {
  try {
    await startTyping(threadId, "Reviewing...");

    const skills = await discoverSkills([".agents/skills"]);

    const agent = createAgent(
      sandboxId,
      threadId,
      prNumber,
      repoFullName,
      skills
    );

    await agent.stream({
      maxSteps: 20,
      messages: threadMessages.map((msg) => ({
        content: msg.content,
        role: msg.role,
      })),
      writable: getWritable<UIMessageChunk>(),
    });

    return { success: true };
  } catch (error) {
    return {
      errorMessage: parseError(error),
      success: false,
    };
  }
};
