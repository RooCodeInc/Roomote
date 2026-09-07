import {
  db,
  fastAgentConversations,
  taskFactory,
  userFactory,
} from '../../server';

import {
  claimFastAgentPrFeedbackDelivery,
  completeFastAgentPrFeedbackDelivery,
  releaseFastAgentPrFeedbackDelivery,
} from '../fast-agent-pr-feedback-deliveries';

/**
 * Each case seeds its own conversation identity so runs stay independent
 * without deleting rows other suites may still reference.
 */
async function seedConversation() {
  const user = await userFactory.create();
  const conversation = {
    surface: 'slack' as const,
    workspaceId: `T-${user.id}`,
    conversationId: '100.1',
  };
  await db.insert(fastAgentConversations).values({
    userId: user.id,
    ...conversation,
    currentReplyChannelId: 'C123',
    currentReplyThreadId: '100.1',
  });
  const first = await taskFactory.create({ initiatorUserId: user.id });
  const second = await taskFactory.create({ initiatorUserId: user.id });

  return { conversation, firstTaskId: first.id, secondTaskId: second.id };
}

const anHourFromNow = () => new Date(Date.now() + 60 * 60 * 1000);

describe('fast agent PR feedback delivery claims', () => {
  it('lets only one task claim an identity and blocks it after delivery', async () => {
    const { conversation, firstTaskId, secondTaskId } =
      await seedConversation();

    const first = await claimFastAgentPrFeedbackDelivery({
      conversation,
      feedbackId: 'feedback-1',
      taskId: firstTaskId,
    });
    if (first.status !== 'claimed') {
      throw new Error(`expected a claim, got ${first.status}`);
    }

    // A sibling task projecting the same logical event must not double-post.
    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation,
        feedbackId: 'feedback-1',
        taskId: secondTaskId,
      }),
    ).resolves.toEqual({ status: 'already_claimed' });

    await completeFastAgentPrFeedbackDelivery(first.claim);

    // Delivery is terminal: an expired lease must not reopen it.
    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation,
        feedbackId: 'feedback-1',
        taskId: secondTaskId,
        now: anHourFromNow(),
      }),
    ).resolves.toEqual({ status: 'already_claimed' });
  });

  it('reopens the identity when a lease expires or is released', async () => {
    const { conversation, firstTaskId, secondTaskId } =
      await seedConversation();

    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation,
        feedbackId: 'feedback-2',
        taskId: firstTaskId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });

    const reclaimed = await claimFastAgentPrFeedbackDelivery({
      conversation,
      feedbackId: 'feedback-2',
      taskId: secondTaskId,
      now: anHourFromNow(),
    });
    if (reclaimed.status !== 'claimed') {
      throw new Error('expected the expired lease to be reclaimable');
    }

    await releaseFastAgentPrFeedbackDelivery(reclaimed.claim);

    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation,
        feedbackId: 'feedback-2',
        taskId: firstTaskId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
  });

  it('scopes claims to one conversation', async () => {
    const first = await seedConversation();
    const second = await seedConversation();

    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation: first.conversation,
        feedbackId: 'shared-feedback',
        taskId: first.firstTaskId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });

    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation: second.conversation,
        feedbackId: 'shared-feedback',
        taskId: second.firstTaskId,
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
  });

  it('reports a missing conversation rather than a taken claim', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });

    await expect(
      claimFastAgentPrFeedbackDelivery({
        conversation: {
          surface: 'slack',
          workspaceId: `T-missing-${user.id}`,
          conversationId: '999.9',
        },
        feedbackId: 'feedback-3',
        taskId: task.id,
      }),
    ).resolves.toEqual({ status: 'no_conversation' });
  });
});
