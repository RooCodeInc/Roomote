import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or } from 'drizzle-orm';

import type { FastAgentConversation } from '@roomote/types';

import { db } from '../db';
import {
  fastAgentConversations,
  fastAgentPrFeedbackDeliveries,
} from '../schema';

const FAST_AGENT_PR_FEEDBACK_LEASE_MS = 15 * 60 * 1000;

export type FastAgentPrFeedbackDeliveryClaim = {
  id: string;
  leaseToken: string;
};

export async function claimFastAgentPrFeedbackDelivery(params: {
  conversation: Pick<
    FastAgentConversation,
    'surface' | 'workspaceId' | 'conversationId'
  >;
  feedbackId: string;
  taskId: string;
  now?: Date;
}): Promise<FastAgentPrFeedbackDeliveryClaim | null> {
  const conversation = await db.query.fastAgentConversations.findFirst({
    where: and(
      eq(fastAgentConversations.surface, params.conversation.surface),
      eq(fastAgentConversations.workspaceId, params.conversation.workspaceId),
      eq(
        fastAgentConversations.conversationId,
        params.conversation.conversationId,
      ),
    ),
    columns: { id: true },
  });
  if (!conversation) {
    return null;
  }

  const now = params.now ?? new Date();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + FAST_AGENT_PR_FEEDBACK_LEASE_MS,
  );
  const [claim] = await db
    .insert(fastAgentPrFeedbackDeliveries)
    .values({
      conversationId: conversation.id,
      feedbackId: params.feedbackId,
      taskId: params.taskId,
      leaseToken,
      leaseExpiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        fastAgentPrFeedbackDeliveries.conversationId,
        fastAgentPrFeedbackDeliveries.feedbackId,
      ],
      set: {
        taskId: params.taskId,
        leaseToken,
        leaseExpiresAt,
        updatedAt: now,
      },
      setWhere: and(
        isNull(fastAgentPrFeedbackDeliveries.deliveredAt),
        or(
          isNull(fastAgentPrFeedbackDeliveries.leaseExpiresAt),
          lte(fastAgentPrFeedbackDeliveries.leaseExpiresAt, now),
        ),
      ),
    })
    .returning({ id: fastAgentPrFeedbackDeliveries.id });

  return claim ? { id: claim.id, leaseToken } : null;
}

export async function completeFastAgentPrFeedbackDelivery(
  claim: FastAgentPrFeedbackDeliveryClaim,
): Promise<void> {
  await db
    .update(fastAgentPrFeedbackDeliveries)
    .set({
      deliveredAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fastAgentPrFeedbackDeliveries.id, claim.id),
        eq(fastAgentPrFeedbackDeliveries.leaseToken, claim.leaseToken),
      ),
    );
}

export async function releaseFastAgentPrFeedbackDelivery(
  claim: FastAgentPrFeedbackDeliveryClaim,
): Promise<void> {
  await db
    .delete(fastAgentPrFeedbackDeliveries)
    .where(
      and(
        eq(fastAgentPrFeedbackDeliveries.id, claim.id),
        eq(fastAgentPrFeedbackDeliveries.leaseToken, claim.leaseToken),
        isNull(fastAgentPrFeedbackDeliveries.deliveredAt),
      ),
    );
}
