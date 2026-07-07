import {
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
} from '@roomote/types';
import { getReviewCodeAutomationSettings } from '@roomote/db/server';

import { getLinkedTaskRelayState } from './linkedTaskRelay';

function hasRoomoteTaskAttribution(prBody: string | null | undefined): boolean {
  if (!prBody) {
    return false;
  }

  const hasTaskLink = /\[[^\]]+\]\([^)]*\/task\/[^)]*\)/.test(prBody);
  const hasRoomoteAttributionLine =
    /Opened on behalf of|Created by Roomote(?: from an unlinked [^.]+)?\./.test(
      prBody,
    );

  return hasTaskLink && hasRoomoteAttributionLine;
}

export async function getReviewTaskRelayPayload({
  repository,
  prNumber,
  branchName,
  prBody,
  reviewerSettings,
}: {
  repository: string;
  prNumber: number;
  branchName: string;
  prBody?: string | null;
  reviewerSettings?: PrReviewerSettings | null;
}): Promise<{
  relayReviewResultsToTask?: boolean;
  linkedTaskId?: string;
  linkedTaskRelayLookupPending?: boolean;
}> {
  const settings =
    reviewerSettings ?? (await getReviewCodeAutomationSettings());
  const relayRequested =
    settings.relayReviewResultsToTask ??
    DEFAULT_PR_REVIEWER_SETTINGS.relayReviewResultsToTask;

  if (!relayRequested) {
    return { relayReviewResultsToTask: false };
  }

  const relayState = await getLinkedTaskRelayState({
    repository,
    prNumber,
    branchName,
    reviewerSettings: settings,
    ownerLookupPendingOnMiss: hasRoomoteTaskAttribution(prBody),
  });

  if (relayState.ownerLookupPending) {
    return { linkedTaskRelayLookupPending: true };
  }

  if (relayState.relayEnabled && relayState.linkedTaskId) {
    return {
      relayReviewResultsToTask: true,
      linkedTaskId: relayState.linkedTaskId,
    };
  }

  return { relayReviewResultsToTask: false };
}
