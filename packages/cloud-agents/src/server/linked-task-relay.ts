import {
  db,
  eq,
  findReusableGitHubPrFollowUpOwner,
  getReviewCodeAutomationSettings,
  tasks,
} from '@roomote/db/server';
import { type PrReviewSettings } from '@roomote/types';

export type LinkedTaskRelayState = {
  linkedTaskId: string | null;
  relayEnabled: boolean;
  ownerLookupPending?: true;
};

function getRelayEligibleCreatorIds(
  settings: PrReviewSettings | null | undefined,
): Set<string> {
  if (!Array.isArray(settings?.relayEligibleCreatorIds)) {
    return new Set();
  }

  return new Set(
    settings.relayEligibleCreatorIds.filter((userId): userId is string =>
      Boolean(userId),
    ),
  );
}

export async function getLinkedTaskRelayState({
  repository,
  prNumber,
  branchName,
  reviewerSettings,
  ownerLookupPendingOnMiss = false,
}: {
  repository: string;
  prNumber: number;
  branchName: string;
  reviewerSettings?: PrReviewSettings | null;
  ownerLookupPendingOnMiss?: boolean;
}): Promise<LinkedTaskRelayState> {
  const settings =
    reviewerSettings ?? (await getReviewCodeAutomationSettings());

  if (!settings.relayReviewResultsToTask) {
    return {
      linkedTaskId: null,
      relayEnabled: false,
    };
  }

  const linkedTaskOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: repository,
    prNumber,
    branchName,
  });

  if (!linkedTaskOwner?.taskId) {
    return {
      linkedTaskId: null,
      relayEnabled: false,
      ...(ownerLookupPendingOnMiss ? { ownerLookupPending: true } : {}),
    };
  }

  const linkedTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, linkedTaskOwner.taskId),
    columns: {
      id: true,
      initiatorUserId: true,
    },
  });

  if (!linkedTask) {
    return {
      linkedTaskId: null,
      relayEnabled: false,
    };
  }

  if (!linkedTask.initiatorUserId) {
    return {
      linkedTaskId: linkedTask.id,
      relayEnabled: false,
    };
  }

  return {
    linkedTaskId: linkedTask.id,
    relayEnabled: getRelayEligibleCreatorIds(settings).has(
      linkedTask.initiatorUserId,
    ),
  };
}

export async function isLinkedTaskCreatorRelayEnabled({
  repository,
  prNumber,
  branchName,
  reviewerSettings,
}: {
  repository: string;
  prNumber: number;
  branchName: string;
  reviewerSettings?: PrReviewSettings | null;
}): Promise<boolean> {
  return (
    await getLinkedTaskRelayState({
      repository,
      prNumber,
      branchName,
      reviewerSettings,
    })
  ).relayEnabled;
}
