import {
  claimCanonicalPrReviewAction,
  completeCanonicalPrReviewActionDispatch,
  releaseCanonicalPrReviewActionDispatch,
} from '@roomote/db/server';
import { dispatchPrReviewFollowUp } from '@roomote/sdk/server';
import {
  type PrReviewActionChoice,
  type PrReviewActionOfferStatus,
} from '@roomote/types';

type WebPrReviewActionInput = {
  deliveryId: string;
  choice: PrReviewActionChoice;
  actingUserId: string;
  expectedDestinationKind: 'fast_conversation' | 'task';
  expectedDestinationKey: string;
  getOfferStatus: () => Promise<PrReviewActionOfferStatus | null>;
  updateOfferStatus: (
    status: Exclude<PrReviewActionOfferStatus, 'stale'>,
  ) => Promise<void>;
};

/**
 * Owns the canonical lifecycle shared by every web review-action surface.
 * Authorization remains with the route because Fast conversations and coding
 * tasks have different access rules; once authorized, their claim, dispatch,
 * retry, and terminal-state behavior must stay identical.
 */
export async function handleWebPrReviewAction(
  input: WebPrReviewActionInput,
): Promise<{ status: PrReviewActionOfferStatus }> {
  const action = await claimCanonicalPrReviewAction({
    deliveryId: input.deliveryId,
    choice: input.choice,
    actingUserId: input.actingUserId,
    expectedDestinationKind: input.expectedDestinationKind,
    expectedDestinationKey: input.expectedDestinationKey,
  });

  if (!action) {
    // Another request may have completed this offer. Return its durable state
    // without letting the losing request replace that state with `stale`.
    return { status: (await input.getOfferStatus()) ?? 'stale' };
  }

  if (input.choice === 'dismiss') {
    await input.updateOfferStatus('dismissed');
    return { status: 'dismissed' };
  }

  const { taskId, followUpPrompt } = action;
  if (!taskId || !followUpPrompt) {
    await releaseCanonicalPrReviewActionDispatch(input.deliveryId);
    throw new Error('Claimed review action is missing its dispatch target');
  }

  let dispatched: Awaited<ReturnType<typeof dispatchPrReviewFollowUp>>;
  try {
    dispatched = await dispatchPrReviewFollowUp({
      provider: 'web',
      taskId,
      followUpPrompt,
      actingUserId: input.actingUserId,
      idempotencyKey: `pr-review-delivery:${input.deliveryId}`,
    });
  } catch (error) {
    const released = await releaseCanonicalPrReviewActionDispatch(
      input.deliveryId,
    );
    if (released) {
      await input.updateOfferStatus('pending');
    }
    throw error;
  }

  if (dispatched.outcome === 'unavailable') {
    const released = await releaseCanonicalPrReviewActionDispatch(
      input.deliveryId,
    );
    if (!released) {
      return { status: 'stale' };
    }

    await input.updateOfferStatus('pending');
    return { status: 'pending' };
  }

  await completeCanonicalPrReviewActionDispatch({
    deliveryId: input.deliveryId,
    runId: dispatched.runId,
  });
  const status = input.choice === 'auto' ? 'auto_resolved' : 'resolved';
  await input.updateOfferStatus(status);
  return { status };
}
