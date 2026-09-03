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
  type FastAgentParent,
  type PrReviewSettings,
  type SourceControlProvider,
} from '@roomote/types';

export type LinkedTaskRelayState = {
  linkedTaskId: string | null;
  relayEnabled: boolean;
  handoffTarget?: 'fast_parent' | 'implementation_task';
  ownerLookupPending?: true;
  /** The Fast parent of the task that opened the PR, when it has one. */
  fastAgentParent?: FastAgentParent;
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
  const fastParent = getFastAgentParentFromPayload(latestRun?.payload);
  const hasFastParent = Boolean(fastParent);

  if (!linkedTask.initiatorUserId) {
    return {
      linkedTaskId: linkedTask.id,
      relayEnabled: hasFastParent,
      ...(fastParent
        ? { handoffTarget: 'fast_parent' as const, fastAgentParent: fastParent }
        : {}),
    };
  }

  const creatorRelayEnabled =
    settings.relayReviewResultsToTask === true &&
    getRelayEligibleCreatorIds(settings).has(linkedTask.initiatorUserId);

  return {
    linkedTaskId: linkedTask.id,
    relayEnabled: hasFastParent || creatorRelayEnabled,
    ...(fastParent
      ? { handoffTarget: 'fast_parent' as const, fastAgentParent: fastParent }
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

/**
 * The Fast parent of the session-delegated task that opened this PR, for
 * attaching follow-on work (like the PR's review task) to the same session.
 */
export async function getPrOriginFastAgentParent({
  repository,
  prNumber,
  branchName,
  sourceControlProvider = 'github',
  host,
}: {
  repository: string;
  prNumber: number;
  branchName: string;
  sourceControlProvider?: SourceControlProvider;
  host?: string | null;
}): Promise<FastAgentParent | null> {
  const owner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: repository,
    prNumber,
    branchName,
    sourceControlProvider,
    ...(host ? { host } : {}),
  });
  if (!owner?.taskId) {
    return null;
  }

  const latestRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, owner.taskId),
    orderBy: [desc(taskRuns.createdAt)],
    columns: { payload: true },
  });
  return getFastAgentParentFromPayload(latestRun?.payload);
}
