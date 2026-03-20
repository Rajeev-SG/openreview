import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import { z } from "zod";

const SANDBOX_CWD = ".";

const writeFileStep = async (
  sandboxId: string,
  path: string,
  content: string
): Promise<{ success: boolean }> => {
  "use step";

  const sandbox = await Sandbox.get({ sandboxId });
  const resolvedPath = path.startsWith("/") ? path : `${SANDBOX_CWD}/${path}`;

  await sandbox.writeFiles([
    { content: Buffer.from(content), path: resolvedPath },
  ]);

  return { success: true };
};

export const createWriteFileTool = (sandboxId: string) =>
  tool({
    description:
      "Write content to a file in the sandbox. Creates parent directories if needed.",
    execute: ({ content, path }) => writeFileStep(sandboxId, path, content),
    inputSchema: z.object({
      content: z.string().describe("The content to write to the file"),
      path: z.string().describe("The path where the file should be written"),
    }),
  });
