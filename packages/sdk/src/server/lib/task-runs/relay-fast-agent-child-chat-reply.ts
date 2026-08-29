import { createHash } from 'node:crypto';

import { and, db, eq, taskRuns } from '@roomote/db/server';
import { getFastAgentParentFromPayload } from '@roomote/types';

import { deliverFastAgentParentEvent } from '../fast-agent-parent-event';

type FastAgentChildChatReplyPurpose =
  | 'ack'
  | 'progress'
  | 'closeout'
  | 'clarification';

// This relay runs inside a task tool's HTTP request. Keep both phases below
// the upstream request deadline so failures return to the tool and release any
// acquired Fast conversation lock instead of leaving server work detached.
const FAST_CHILD_REPLY_LOCK_WAIT_MS = 30_000;
const FAST_CHILD_REPLY_TURN_TIMEOUT_MS = 30_000;

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

  const delivery = await deliverFastAgentParentEvent({
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
    lockWaitMs: FAST_CHILD_REPLY_LOCK_WAIT_MS,
    turnTimeoutMs: FAST_CHILD_REPLY_TURN_TIMEOUT_MS,
  });

  return { relayed: delivery === 'delivered' };
}
