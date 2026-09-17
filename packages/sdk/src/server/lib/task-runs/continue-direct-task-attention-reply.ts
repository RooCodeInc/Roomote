import { and, db, eq, taskRuns } from '@roomote/db/server';

import type { SessionAttentionKind } from '../session-attention-notification';
import { withSandboxServerRpcClient } from '../auth/sandbox-server-rpc';

export async function continueDirectTaskAttentionReply(input: {
  taskId: string;
  runId: number;
  userId: string;
  question: string;
  kind: SessionAttentionKind;
}): Promise<boolean> {
  const run = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)),
    columns: { sandboxServerUrl: true },
  });
  if (!run?.sandboxServerUrl) return false;

  try {
    await withSandboxServerRpcClient({
      runId: input.runId,
      userId: input.userId,
      sandboxServerUrl: run.sandboxServerUrl,
      call: (client) =>
        client.commands.steerTask.mutate({
          prompt: input.question,
          quoteText: input.question,
          ...(input.kind === 'input_needed'
            ? { answerPendingInput: true }
            : {}),
        }),
    });
    return true;
  } catch (error) {
    console.warn(
      `[continueDirectTaskAttentionReply] Failed for task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
