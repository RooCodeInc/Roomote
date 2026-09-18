import {
  buildFastAgentSessionAttachment,
  type FastAgentParent,
  type PrReviewSettings,
} from '@roomote/types';
import { getReviewCodeAutomationSettings } from '@roomote/db/server';
import { getPrOriginFastAgentParent } from '@roomote/cloud-agents/server';

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
  repositoryId,
  host,
}: {
  repository: string;
  prNumber: number;
  branchName: string;
  prBody?: string | null;
  reviewerSettings?: PrReviewSettings | null;
  /**
   * The reviewing repository's row id; when present, the review is attached
   * to the Fast session of the task that opened the PR, pinned to this exact
   * connected repository so another instance's same-named repository can
   * never supply the session.
   */
  repositoryId?: string | null;
  host?: string | null;
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
  // unrelated one. The lookup is pinned to the reviewing repository row.
  const originParent: FastAgentParent | null = repositoryId
    ? await getPrOriginFastAgentParent({
        repository,
        prNumber,
        branchName,
        repositoryId,
        ...(host ? { host } : {}),
      }).catch(() => null)
    : null;
  const sessionAttachment = originParent
    ? buildFastAgentSessionAttachment(originParent)
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
