import type { Job } from 'bullmq';

import {
  and,
  db,
  desc,
  eq,
  claimPullRequestConflictNotification,
  listTrackedPullRequestsForMergeability,
  markPullRequestConflictNotified,
  recordPullRequestMergeability,
  releasePullRequestConflictNotificationClaim,
  slackInstallations,
  taskRuns,
  updateTrackedPullRequestBaseRef,
  type TrackedPullRequestMergeabilityCandidate,
} from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';
import {
  buildPrReviewNotificationPostInput,
  buildPullRequestConflictMessage,
  enqueuePullRequestMergeabilityCheck,
  getCommunicationProviderAdapter,
  notifyFastAgentParentOnPullRequestConflict,
  pullRequestMergeabilityCheckRequestSchema,
  recordPrReviewNotificationDeliveryBestEffort,
  resolvePrReviewNotificationRoute,
  type PullRequestMergeabilityCheckRequest,
  type PrReviewNotificationRoute,
} from '@roomote/sdk/server';
import {
  postSlackThreadMessageWithStickyFooter,
  SlackNotifier,
} from '@roomote/slack';
import { PR_CONFLICT_NOTIFICATION_TASK_MESSAGE_SOURCE } from '@roomote/types';

type GraphQlMergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
type GraphQlPullRequest = {
  number: number;
  mergeable: GraphQlMergeability;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: string;
};
type GraphQlMergeabilityResponse = {
  repository: Record<string, GraphQlPullRequest | null> | null;
};

export function buildPullRequestMergeabilityQuery(prNumbers: number[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const variables: Record<string, string | number> = {};
  const declarations = prNumbers.map((_, index) => `$pr${index}: Int!`);
  const selections = prNumbers.map((prNumber, index) => {
    variables[`pr${index}`] = prNumber;
    return `pr${index}: pullRequest(number: $pr${index}) { number mergeable state baseRefName }`;
  });

  return {
    query: `query PullRequestMergeability($owner: String!, $repo: String!, ${declarations.join(', ')}) { repository(owner: $owner, name: $repo) { ${selections.join(' ')} } }`,
    variables,
  };
}

/**
 * Octokit rejects the whole call when any alias errors (e.g. one stale PR
 * number resolves to NOT_FOUND), attaching the partial data to the error.
 */
function extractPartialGraphQlData(
  error: unknown,
): GraphQlMergeabilityResponse | null {
  if (
    error instanceof Error &&
    error.name === 'GraphqlResponseError' &&
    'data' in error &&
    typeof error.data === 'object' &&
    error.data !== null
  ) {
    return error.data as GraphQlMergeabilityResponse;
  }
  return null;
}

function buildCandidateConflictText(
  candidate: TrackedPullRequestMergeabilityCandidate,
): string {
  return buildPullRequestConflictMessage({
    title: candidate.prTitle ?? `Pull request #${candidate.prNumber}`,
    url: candidate.prUrl,
  });
}

async function postConflictNotification(params: {
  candidate: TrackedPullRequestMergeabilityCandidate;
  conflictDetectedAt: Date;
}): Promise<boolean> {
  const latestRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, params.candidate.taskId),
    orderBy: [desc(taskRuns.createdAt)],
  });
  if (!latestRun) return false;

  const title =
    params.candidate.prTitle ?? `Pull request #${params.candidate.prNumber}`;
  const deliveredToFastParent =
    await notifyFastAgentParentOnPullRequestConflict({
      run: latestRun,
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        repository: params.candidate.repository,
        number: params.candidate.prNumber,
        title,
        url: params.candidate.prUrl,
      },
      conflictDetectedAt: params.conflictDetectedAt,
    });
  if (deliveredToFastParent) return true;

  const route = await resolvePrReviewNotificationRoute(latestRun);
  const text = buildCandidateConflictText(params.candidate);
  const messageTs = route
    ? await postConflictNotificationToRoute(
        route,
        params.candidate.taskId,
        text,
      )
    : null;

  await recordPrReviewNotificationDeliveryBestEffort({
    runId: latestRun.id,
    taskId: params.candidate.taskId,
    text,
    route,
    messageTs,
    source: PR_CONFLICT_NOTIFICATION_TASK_MESSAGE_SOURCE,
  });
  return true;
}

async function postConflictNotificationToRoute(
  route: PrReviewNotificationRoute,
  taskId: string,
  text: string,
): Promise<string | null> {
  if (route.provider === 'slack') {
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.teamId, route.slackTeamId),
        eq(slackInstallations.isActive, true),
      ),
      columns: { botAccessToken: true },
    });
    if (!installation?.botAccessToken) {
      console.warn(
        '[PullRequestMergeabilityCheck] Slack is not connected, skipping conflict notification',
      );
      return null;
    }

    const messageTs = await postSlackThreadMessageWithStickyFooter({
      slack: new SlackNotifier(installation.botAccessToken),
      channel: route.channelId,
      threadTs: route.threadId,
      taskId,
      text,
      blocks: [{ type: 'markdown', text }],
      utmCampaign: 'slack.pr_conflict',
    });
    return messageTs ?? null;
  }

  const adapter = await getCommunicationProviderAdapter(route.provider);
  if (!adapter) {
    console.warn(
      `[PullRequestMergeabilityCheck] ${route.provider} is not connected, skipping conflict notification`,
    );
    return null;
  }

  await adapter.postMessage(buildPrReviewNotificationPostInput(route, text));
  return null;
}

async function notifyConflictTransition(
  candidate: TrackedPullRequestMergeabilityCandidate,
  conflictDetectedAt: Date,
): Promise<void> {
  const generation = { id: candidate.id, conflictDetectedAt };
  const conflictNotificationClaimedAt =
    await claimPullRequestConflictNotification(generation);
  if (!conflictNotificationClaimedAt) return;
  const claim = { ...generation, conflictNotificationClaimedAt };

  try {
    const delivered = await postConflictNotification({
      candidate,
      conflictDetectedAt,
    });
    if (!delivered) {
      await releasePullRequestConflictNotificationClaim(claim);
      return;
    }
    await markPullRequestConflictNotified(claim);
  } catch (error) {
    await releasePullRequestConflictNotificationClaim(claim).catch(() => {});
    throw error;
  }
}

export async function pullRequestMergeabilityCheckJob(
  job: Job<PullRequestMergeabilityCheckRequest, void, string>,
): Promise<void> {
  const data = pullRequestMergeabilityCheckRequestSchema.parse(job.data);
  const candidates = await listTrackedPullRequestsForMergeability({
    repository: data.repository,
    ...(data.baseRef !== undefined ? { baseRef: data.baseRef } : {}),
    ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}),
    ...(data.taskPullRequestIds !== undefined
      ? { ids: data.taskPullRequestIds }
      : {}),
    skipNotifiedConflicts: !data.allowNotifiedConflictCheck,
  });
  if (candidates.length === 0) return;

  const [owner, repo] = data.repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository: ${data.repository}`);
  }

  const candidatesByNumber = new Map<
    number,
    TrackedPullRequestMergeabilityCandidate[]
  >();
  for (const candidate of candidates) {
    const links = candidatesByNumber.get(candidate.prNumber) ?? [];
    links.push(candidate);
    candidatesByNumber.set(candidate.prNumber, links);
  }

  const prNumbers = [...candidatesByNumber.keys()];
  const { query, variables } = buildPullRequestMergeabilityQuery(prNumbers);
  const octokit = await getInstallationOctokit({
    installationId: data.installationId,
  });

  let response: GraphQlMergeabilityResponse;
  try {
    response = await octokit.graphql<GraphQlMergeabilityResponse>(query, {
      owner,
      repo,
      ...variables,
    });
  } catch (error) {
    const partial = extractPartialGraphQlData(error);
    if (!partial) throw error;
    response = partial;
  }
  const unknownIds: string[] = [];

  await Promise.all(
    prNumbers.map(async (prNumber, index) => {
      const pullRequest = response.repository?.[`pr${index}`];
      const links = candidatesByNumber.get(prNumber) ?? [];
      if (!pullRequest || pullRequest.state !== 'OPEN') return;

      if (links.some((link) => link.prBaseRef !== pullRequest.baseRefName)) {
        await updateTrackedPullRequestBaseRef({
          repository: data.repository,
          prNumber,
          baseRef: pullRequest.baseRefName,
        });
      }

      if (pullRequest.mergeable === 'UNKNOWN') {
        for (const link of links) {
          await recordPullRequestMergeability({
            id: link.id,
            status: 'unknown',
          });
          unknownIds.push(link.id);
        }
        return;
      }

      await Promise.all(
        links.map(async (link) => {
          const observation = await recordPullRequestMergeability({
            id: link.id,
            status:
              pullRequest.mergeable === 'CONFLICTING' ? 'conflicting' : 'clean',
          });
          if (observation.shouldNotify && observation.conflictDetectedAt) {
            await notifyConflictTransition(
              link,
              observation.conflictDetectedAt,
            );
          }
        }),
      );
    }),
  );

  if (unknownIds.length > 0 && data.retryAttempt === 0) {
    await enqueuePullRequestMergeabilityCheck({
      installationId: data.installationId,
      repository: data.repository,
      taskPullRequestIds: unknownIds,
      deduplicationKey: data.deduplicationKey,
      retryAttempt: 1,
      allowNotifiedConflictCheck: data.allowNotifiedConflictCheck,
    });
  }
}
