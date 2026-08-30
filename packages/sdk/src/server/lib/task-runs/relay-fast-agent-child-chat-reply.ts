import { createHash } from 'node:crypto';

import { and, db, eq, taskRuns } from '@roomote/db/server';
import { getFastAgentParentFromPayload } from '@roomote/types';

import { enqueueFastAgentParentEvent } from '../fast-agent-parent-event-queue';

type FastAgentChildChatReplyPurpose =
  | 'ack'
  | 'progress'
  | 'closeout'
  | 'clarification';

/** Route a Fast child's lifecycle message through its conversational parent. */
export async function relayFastAgentChildChatReply(input: {
  runId: number;
  taskId: string;
  deliverySignature: string;
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

  const messageId = createHash('sha256')
    .update(`${parent.sessionId}:${run.id}:${input.deliverySignature}`)
    .digest('hex');

  await enqueueFastAgentParentEvent({
    parent,
    event: {
      type: 'child_message',
      taskId: run.taskId,
      runId: run.id,
      messageId,
      purpose: input.purpose,
      message: input.message,
      ...(input.imageArtifactIds?.length
        ? { imageArtifactIds: [...new Set(input.imageArtifactIds)] }
        : {}),
    },
  });

  return { relayed: true };
}
