import { setTimeout as delay } from 'node:timers/promises';

import { type PrReviewSettings } from '@roomote/types';

import { getLinkedTaskRelayState } from '../linked-task-relay';

const LINKED_TASK_RELAY_LOOKUP_ATTEMPTS = 10;
const LINKED_TASK_RELAY_LOOKUP_DELAY_MS = 500;

export async function resolveLinkedTaskReviewHandoff({
  repository,
  prNumber,
  branchName,
  reviewerSettings,
  payloadRelayReviewResultsToTask,
  payloadLinkedTaskId,
  payloadLinkedTaskRelayLookupPending,
}: {
  repository: string;
  prNumber: number;
  branchName?: string;
  reviewerSettings?: PrReviewSettings | null;
  payloadRelayReviewResultsToTask?: boolean;
  payloadLinkedTaskId?: string;
  payloadLinkedTaskRelayLookupPending?: boolean;
}): Promise<{
  relayReviewResultsToTask: boolean;
  linkedTaskId?: string;
}> {
  if (
    payloadRelayReviewResultsToTask === true &&
    payloadLinkedTaskId?.trim().length
  ) {
    return {
      relayReviewResultsToTask: true,
      linkedTaskId: payloadLinkedTaskId,
    };
  }

  if (payloadRelayReviewResultsToTask === false) {
    return { relayReviewResultsToTask: false };
  }

  if (!payloadRelayReviewResultsToTask) {
    return { relayReviewResultsToTask: false };
  }

  const shouldRetryOwnerLookup = payloadLinkedTaskRelayLookupPending === true;
  const lookupAttempts = shouldRetryOwnerLookup
    ? LINKED_TASK_RELAY_LOOKUP_ATTEMPTS
    : 1;

  for (let attempt = 0; attempt < lookupAttempts; attempt += 1) {
    const relayState = await getLinkedTaskRelayState({
      repository,
      prNumber,
      branchName: branchName ?? '',
      reviewerSettings,
      ownerLookupPendingOnMiss: shouldRetryOwnerLookup,
    });

    if (relayState.relayEnabled && relayState.linkedTaskId) {
      return {
        relayReviewResultsToTask: true,
        linkedTaskId: relayState.linkedTaskId,
      };
    }

    if (!relayState.ownerLookupPending) {
      return { relayReviewResultsToTask: false };
    }

    if (attempt < lookupAttempts - 1) {
      await delay(LINKED_TASK_RELAY_LOOKUP_DELAY_MS);
    }
  }

  return shouldRetryOwnerLookup
    ? { relayReviewResultsToTask: true }
    : { relayReviewResultsToTask: false };
}
