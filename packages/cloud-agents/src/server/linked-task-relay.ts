import {
  db,
  eq,
  findReusableGitHubPrFollowUpOwner,
  getReviewCodeAutomationSettings,
  tasks,
} from '@roomote/db/server';
import { type PrReviewerSettings } from '@roomote/types';

export type LinkedTaskRelayState = {
  linkedTaskId: string | null;
  relayEnabled: boolean;
  ownerLookupPending?: true;
};

function getRelayEligibleCreatorIds(
  settings: PrReviewerSettings | null | undefined,
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
  reviewerSettings?: PrReviewerSettings | null;
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
      userId: true,
    },
  });

  if (!linkedTask) {
    return {
      linkedTaskId: null,
      relayEnabled: false,
    };
  }

  if (!linkedTask.userId) {
    return {
      linkedTaskId: linkedTask.id,
      relayEnabled: false,
    };
  }

  return {
    linkedTaskId: linkedTask.id,
    relayEnabled: getRelayEligibleCreatorIds(settings).has(linkedTask.userId),
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
  reviewerSettings?: PrReviewerSettings | null;
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
