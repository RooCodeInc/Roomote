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
import {
  formatOperationalEvent,
  getFastAgentParentFromPayload,
  getOperationalLogRuntimeFields,
  PR_CONFLICT_NOTIFICATION_TASK_MESSAGE_SOURCE,
  type OperationalLogFields,
} from '@roomote/types';

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

type PullRequestMergeabilityJob = Job<
  PullRequestMergeabilityCheckRequest,
  void,
  string
>;

function logPullRequestConflictEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: OperationalLogFields,
): void {
  const writer =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
  writer(
    formatOperationalEvent(event, {
      ...getOperationalLogRuntimeFields('bullmq', process.env),
      provider: 'github',
      surface: 'github',
      ...fields,
    }),
  );
}

function getJobOperationalFields(
  job: PullRequestMergeabilityJob,
  data: PullRequestMergeabilityCheckRequest,
): OperationalLogFields {
  return {
    repository: data.repository,
    prNumber: data.prNumber,
    jobId: job.id,
    attempt: (job.attemptsMade ?? 0) + 1,
  };
}

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
}): Promise<{
  accepted: boolean;
  level: 'info' | 'warn' | 'error';
  outcome: 'delivered' | 'skipped' | 'failed';
  reason: string;
  runId?: number;
  sessionId?: string;
  routeProvider?: string;
}> {
  const latestRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, params.candidate.taskId),
    orderBy: [desc(taskRuns.createdAt)],
  });
  if (!latestRun) {
    return {
      accepted: false,
      level: 'warn',
      outcome: 'skipped',
      reason: 'task_run_missing',
    };
  }

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
  if (deliveredToFastParent) {
    return {
      accepted: true,
      level: 'info',
      outcome: 'delivered',
      reason: 'fast_parent_notified',
      runId: latestRun.id,
      sessionId: getFastAgentParentFromPayload(latestRun.payload)?.sessionId,
    };
  }

  const route = await resolvePrReviewNotificationRoute(latestRun);
  const text = buildCandidateConflictText(params.candidate);
  const routeResult = route
    ? await postConflictNotificationToRoute(
        route,
        params.candidate.taskId,
        text,
      )
    : null;

  const recorded = await recordPrReviewNotificationDeliveryBestEffort({
    runId: latestRun.id,
    taskId: params.candidate.taskId,
    text,
    route,
    messageTs: routeResult?.messageId,
    source: PR_CONFLICT_NOTIFICATION_TASK_MESSAGE_SOURCE,
  });

  if (!route) {
    return {
      accepted: true,
      level: recorded ? 'info' : 'error',
      outcome: recorded ? 'skipped' : 'failed',
      reason: recorded
        ? 'no_notification_route'
        : 'task_history_persistence_failed',
      runId: latestRun.id,
    };
  }

  return {
    accepted: true,
    level: routeResult?.delivered ? 'info' : 'error',
    outcome: routeResult?.delivered ? 'delivered' : 'failed',
    reason: routeResult?.reason ?? 'notification_route_failed',
    runId: latestRun.id,
    routeProvider: route.provider,
  };
}

async function postConflictNotificationToRoute(
  route: PrReviewNotificationRoute,
  taskId: string,
  text: string,
): Promise<{
  delivered: boolean;
  messageId: string | null;
  reason: string;
}> {
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
      return {
        delivered: false,
        messageId: null,
        reason: 'provider_not_connected',
      };
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
    return messageTs
      ? {
          delivered: true,
          messageId: messageTs,
          reason: 'conversation_notification_posted',
        }
      : {
          delivered: false,
          messageId: null,
          reason: 'provider_message_id_missing',
        };
  }

  const adapter = await getCommunicationProviderAdapter(route.provider);
  if (!adapter) {
    console.warn(
      `[PullRequestMergeabilityCheck] ${route.provider} is not connected, skipping conflict notification`,
    );
    return {
      delivered: false,
      messageId: null,
      reason: 'provider_not_connected',
    };
  }

  await adapter.postMessage(buildPrReviewNotificationPostInput(route, text));
  return {
    delivered: true,
    messageId: null,
    reason: 'conversation_notification_posted',
  };
}

async function notifyConflictTransition(
  candidate: TrackedPullRequestMergeabilityCandidate,
  conflictDetectedAt: Date,
  jobFields: OperationalLogFields,
): Promise<void> {
  const generation = { id: candidate.id, conflictDetectedAt };
  const conflictNotificationClaimedAt =
    await claimPullRequestConflictNotification(generation);
  if (!conflictNotificationClaimedAt) {
    logPullRequestConflictEvent(
      'info',
      'source_control_pr_conflict_notification',
      {
        ...jobFields,
        prNumber: candidate.prNumber,
        taskId: candidate.taskId,
        outcome: 'skipped',
        reason: 'notification_claim_unavailable',
      },
    );
    return;
  }
  const claim = { ...generation, conflictNotificationClaimedAt };
  let terminalLogged = false;

  try {
    const result = await postConflictNotification({
      candidate,
      conflictDetectedAt,
    });
    if (!result.accepted) {
      await releasePullRequestConflictNotificationClaim(claim);
      logPullRequestConflictEvent(
        result.level,
        'source_control_pr_conflict_notification',
        {
          ...jobFields,
          prNumber: candidate.prNumber,
          taskId: candidate.taskId,
          outcome: result.outcome,
          reason: result.reason,
          retryable: false,
        },
      );
      terminalLogged = true;
      return;
    }
    await markPullRequestConflictNotified(claim);
    logPullRequestConflictEvent(
      result.level,
      'source_control_pr_conflict_notification',
      {
        ...jobFields,
        prNumber: candidate.prNumber,
        taskId: candidate.taskId,
        runId: result.runId,
        sessionId: result.sessionId,
        routeProvider: result.routeProvider,
        outcome: result.outcome,
        reason: result.reason,
        retryable: false,
      },
    );
    terminalLogged = true;
  } catch (error) {
    await releasePullRequestConflictNotificationClaim(claim).catch(() => {});
    if (!terminalLogged) {
      logPullRequestConflictEvent(
        'error',
        'source_control_pr_conflict_notification',
        {
          ...jobFields,
          prNumber: candidate.prNumber,
          taskId: candidate.taskId,
          outcome: 'failed',
          reason: error instanceof Error ? error.name : 'unknown_error',
          retryable: false,
        },
      );
    }
    throw error;
  }
}

async function runPullRequestMergeabilityCheck(
  data: PullRequestMergeabilityCheckRequest,
  operationalFields: OperationalLogFields,
  startedAt: number,
): Promise<void> {
  const candidates = await listTrackedPullRequestsForMergeability({
    repository: data.repository,
    ...(data.baseRef !== undefined ? { baseRef: data.baseRef } : {}),
    ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}),
    ...(data.taskPullRequestIds !== undefined
      ? { ids: data.taskPullRequestIds }
      : {}),
    skipNotifiedConflicts: !data.allowNotifiedConflictCheck,
  });
  if (candidates.length === 0) {
    logPullRequestConflictEvent(
      'info',
      'source_control_pr_mergeability_check',
      {
        ...operationalFields,
        outcome: 'skipped',
        reason: 'no_eligible_tracked_pull_requests',
        durationMs: Date.now() - startedAt,
        retryable: false,
      },
    );
    return;
  }

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
      if (!pullRequest || pullRequest.state !== 'OPEN') {
        logPullRequestConflictEvent(
          'info',
          'source_control_pr_mergeability_check',
          {
            ...operationalFields,
            prNumber,
            outcome: 'skipped',
            reason: pullRequest
              ? 'pull_request_not_open'
              : 'pull_request_not_found',
            durationMs: Date.now() - startedAt,
            retryable: false,
          },
        );
        return;
      }

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
        logPullRequestConflictEvent(
          'warn',
          'source_control_pr_mergeability_check',
          {
            ...operationalFields,
            prNumber,
            outcome: 'unknown',
            reason: 'provider_mergeability_unknown',
            durationMs: Date.now() - startedAt,
            retryable: data.retryAttempt === 0,
          },
        );
        return;
      }

      const conflicting = pullRequest.mergeable === 'CONFLICTING';
      logPullRequestConflictEvent(
        'info',
        'source_control_pr_mergeability_check',
        {
          ...operationalFields,
          prNumber,
          outcome: conflicting ? 'conflicting' : 'clean',
          reason: conflicting
            ? 'provider_reported_conflicting'
            : 'provider_reported_mergeable',
          durationMs: Date.now() - startedAt,
          retryable: false,
        },
      );

      await Promise.all(
        links.map(async (link) => {
          const observation = await recordPullRequestMergeability({
            id: link.id,
            status: conflicting ? 'conflicting' : 'clean',
          });
          if (observation.shouldNotify && observation.conflictDetectedAt) {
            await notifyConflictTransition(
              link,
              observation.conflictDetectedAt,
              operationalFields,
            );
          } else if (conflicting) {
            logPullRequestConflictEvent(
              'info',
              'source_control_pr_conflict_notification',
              {
                ...operationalFields,
                prNumber: link.prNumber,
                taskId: link.taskId,
                outcome: 'skipped',
                reason: 'conflict_transition_not_notifiable',
                retryable: false,
              },
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

export async function pullRequestMergeabilityCheckJob(
  job: PullRequestMergeabilityJob,
): Promise<void> {
  const data = pullRequestMergeabilityCheckRequestSchema.parse(job.data);
  const operationalFields = getJobOperationalFields(job, data);
  const startedAt = Date.now();
  logPullRequestConflictEvent('info', 'source_control_pr_mergeability_check', {
    ...operationalFields,
    outcome: 'started',
    reason: 'job_received',
  });

  try {
    await runPullRequestMergeabilityCheck(data, operationalFields, startedAt);
  } catch (error) {
    logPullRequestConflictEvent(
      'error',
      'source_control_pr_mergeability_check',
      {
        ...operationalFields,
        outcome: 'failed',
        reason: error instanceof Error ? error.name : 'unknown_error',
        durationMs: Date.now() - startedAt,
        retryable: false,
      },
    );
    throw error;
  }
}
