import { and, db, eq, taskRuns } from '@roomote/db/server';
import { getFastAgentParentFromPayload } from '@roomote/types';

import { deliverFastAgentParentEvent } from '../fast-agent-parent-event';

export type FastAgentChildChatReplyPurpose =
  | 'ack'
  | 'progress'
  | 'closeout'
  | 'clarification';

/** Route a Fast child's lifecycle message through its conversational parent. */
export async function relayFastAgentChildChatReply(input: {
  runId: number;
  taskId: string;
  messageId: string;
  purpose: FastAgentChildChatReplyPurpose;
  message: string;
  imageArtifactIds?: string[];
}): Promise<{ relayed: boolean }> {
  const run = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)),
    columns: { id: true, taskId: true, payload: true },
  });
  const parent = getFastAgentParentFromPayload(run?.payload);

  if (!run || !parent) {
    return { relayed: false };
  }

  const delivery = await deliverFastAgentParentEvent({
    parent,
    event: {
      type: 'child_message',
      taskId: run.taskId,
      runId: run.id,
      messageId: input.messageId,
      purpose: input.purpose,
      message: input.message,
      ...(input.imageArtifactIds?.length
        ? { imageArtifactIds: [...new Set(input.imageArtifactIds)] }
        : {}),
    },
  });

  return { relayed: delivery === 'delivered' };
}
