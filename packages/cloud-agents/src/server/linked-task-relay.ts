import {
  db,
  desc,
  eq,
  findReusableGitHubPrFollowUpOwner,
  getReviewCodeAutomationSettings,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  type PrReviewSettings,
} from '@roomote/types';

export type LinkedTaskRelayState = {
  linkedTaskId: string | null;
  relayEnabled: boolean;
  handoffTarget?: 'fast_parent' | 'implementation_task';
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

  const latestRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, linkedTask.id),
    orderBy: [desc(taskRuns.createdAt)],
    columns: { payload: true },
  });
  const hasFastParent = Boolean(
    getFastAgentParentFromPayload(latestRun?.payload),
  );

  if (!linkedTask.initiatorUserId) {
    return {
      linkedTaskId: linkedTask.id,
      relayEnabled: hasFastParent,
      ...(hasFastParent ? { handoffTarget: 'fast_parent' as const } : {}),
    };
  }

  const creatorRelayEnabled =
    settings.relayReviewResultsToTask === true &&
    getRelayEligibleCreatorIds(settings).has(linkedTask.initiatorUserId);

  return {
    linkedTaskId: linkedTask.id,
    relayEnabled: hasFastParent || creatorRelayEnabled,
    ...(hasFastParent
      ? { handoffTarget: 'fast_parent' as const }
      : creatorRelayEnabled
        ? { handoffTarget: 'implementation_task' as const }
        : {}),
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
