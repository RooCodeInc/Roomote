import {
  buildFastAgentSessionAttachment,
  type FastAgentParent,
  type PrReviewSettings,
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
  reviewerSettings?: PrReviewSettings | null;
}): Promise<{
  relayReviewResultsToTask?: boolean;
  linkedTaskId?: string;
  linkedTaskRelayLookupPending?: boolean;
  linkedReviewHandoffTarget?: 'fast_parent' | 'implementation_task';
  fastAgentSessionId?: string;
  fastAgentParent?: FastAgentParent;
}> {
  const settings =
    reviewerSettings ?? (await getReviewCodeAutomationSettings());

  const relayState = await getLinkedTaskRelayState({
    repository,
    prNumber,
    branchName,
    reviewerSettings: settings,
    ownerLookupPendingOnMiss: hasRoomoteTaskAttribution(prBody),
  });

  if (relayState.ownerLookupPending) {
    return {
      relayReviewResultsToTask: true,
      linkedTaskRelayLookupPending: true,
    };
  }

  // A PR opened by a session-delegated task pulls its review into that same
  // session, so the review shows up as a task there instead of spawning an
  // unrelated one.
  const sessionAttachment = relayState.fastAgentParent
    ? buildFastAgentSessionAttachment(relayState.fastAgentParent)
    : {};

  if (relayState.relayEnabled && relayState.linkedTaskId) {
    return {
      relayReviewResultsToTask: true,
      linkedTaskId: relayState.linkedTaskId,
      ...(relayState.handoffTarget
        ? { linkedReviewHandoffTarget: relayState.handoffTarget }
        : {}),
      ...sessionAttachment,
    };
  }

  return { relayReviewResultsToTask: false, ...sessionAttachment };
}
