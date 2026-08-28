import { z } from 'zod';

import {
  and,
  db,
  desc,
  eq,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type SourceControlProvider,
  sourceControlProviderSchema,
} from '@roomote/types';

import { recordTaskMessageEnvelope } from './record-task-message-envelope';
import { notifyFastAgentParentOnPullRequestStatusChanged } from './notify-fast-agent-parent-on-pull-request-status-changed';

const STATUS_RECORDED_TTL_SECONDS = 30 * 24 * 60 * 60;

export const recordPrStatusChangeInTaskHistoryInputSchema = z.object({
  repository: z.string().min(1),
  prNumber: z.number().int().positive(),
  prTitle: z.string().default('untitled'),
  prUrl: z.string().min(1),
  status: z.enum(['merged', 'closed']),
  actorLogin: z.string().default('someone'),
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type RecordPrStatusChangeInTaskHistoryInput = z.infer<
  typeof recordPrStatusChangeInTaskHistoryInputSchema
>;

type RecordPrStatusChangeInTaskHistoryResult = {
  recordedTaskCount: number;
  reason?: string;
};

/** Fast delivery completed, but the independent task-history persistence did
 * not. Webhook callers should retry history without restoring direct Fast
 * conversation delivery, which would duplicate the already-posted event. */
export class PrStatusHistoryRecordingError extends Error {}

/** Fast delivery failed for specific linked tasks. Webhook callers can restore
 * direct delivery only for these targets without duplicating earlier tasks. */
export class PrStatusFastDeliveryError extends Error {
  readonly taskIds: string[];

  constructor(message: string, taskIds: string[], options?: ErrorOptions) {
    super(message, options);
    this.taskIds = taskIds;
  }
}

/**
 * Provider-native shorthand for a pull/merge request number.
 * GitHub/Gitea/Bitbucket use `#n`, GitLab uses `!n`, Azure DevOps has no
 * short sigil so the number is labeled as a PR.
 */
export function formatPullRequestReference({
  repository,
  prNumber,
  sourceControlProvider = 'github',
}: {
  repository: string;
  prNumber: number;
  sourceControlProvider?: SourceControlProvider;
}): string {
  switch (sourceControlProvider) {
    case 'gitlab':
      return `${repository}!${prNumber}`;
    case 'ado':
      return `${repository} PR ${prNumber}`;
    case 'github':
    case 'gitea':
    case 'bitbucket':
    default:
      return `${repository}#${prNumber}`;
  }
}

/**
 * Builds the plain-text task-history line for a terminal PR status change so
 * the agent (and transcript) see the same event signal as users do in chat.
 */
export function formatPrStatusChangeTaskHistoryText({
  repository,
  prNumber,
  prTitle,
  prUrl,
  status,
  actorLogin,
  sourceControlProvider = 'github',
}: Omit<RecordPrStatusChangeInTaskHistoryInput, never> & {
  sourceControlProvider?: SourceControlProvider;
}): string {
  const reference = formatPullRequestReference({
    repository,
    prNumber,
    sourceControlProvider,
  });

  return `${reference} (${prTitle}) was ${status} by ${actorLogin}\n${prUrl}`;
}

function buildStatusRecordedKey({
  sourceControlProvider,
  repository,
  prNumber,
  status,
  taskId,
}: {
  sourceControlProvider: string;
  repository: string;
  prNumber: number;
  status: 'merged' | 'closed';
  taskId: string;
}): string {
  return `pr-status-notification:recorded:${sourceControlProvider}:${encodeURIComponent(
    repository,
  )}#${prNumber}:${status}:${taskId}`;
}

/**
 * Persists an out-of-band assistant task-history message for each Roomote task
 * linked to a pull request when that PR is merged or closed. Mirrors the
 * PR-review notification source-of-truth path so the next agent turn re-surfaces
 * the status change without starting a new turn here.
 *
 * Message timestamps use `Date.now()` (not provider event times) so two
 * terminal events in the same second cannot collide on the
 * `(taskId, protocol, ts, eventType)` unique key. Webhook-retry idempotency is
 * owned by the Redis claim key below.
 */
export async function recordPrStatusChangeInTaskHistory(
  input: RecordPrStatusChangeInTaskHistoryInput,
): Promise<RecordPrStatusChangeInTaskHistoryResult> {
  const parsedInput = recordPrStatusChangeInTaskHistoryInputSchema.parse(input);
  const sourceControlProvider = parsedInput.sourceControlProvider ?? 'github';

  const prTaskLinks = await db.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
      eq(taskPullRequests.repository, parsedInput.repository),
      eq(taskPullRequests.prNumber, parsedInput.prNumber),
    ),
    columns: { taskId: true },
  });

  const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

  if (taskIds.length === 0) {
    return { recordedTaskCount: 0, reason: 'no_linked_tasks' };
  }

  const text = formatPrStatusChangeTaskHistoryText({
    repository: parsedInput.repository,
    prNumber: parsedInput.prNumber,
    prTitle: parsedInput.prTitle,
    prUrl: parsedInput.prUrl,
    status: parsedInput.status,
    actorLogin: parsedInput.actorLogin,
    sourceControlProvider,
  });
  const redis = getRedis();

  let recordedTaskCount = 0;
  let claimedTaskCount = 0;
  let skippedAlreadyRecorded = 0;
  let historyError: PrStatusHistoryRecordingError | null = null;
  let fastDeliveryCause: unknown;
  const fastFallbackTaskIds: string[] = [];

  for (const taskId of taskIds) {
    const latestRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, taskId),
      orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      columns: { id: true, taskId: true, payload: true },
    });

    if (!latestRun) {
      continue;
    }

    // Fast delivery owns the user-visible event for Fast conversations and has
    // its own durable delivery claim. Complete it before history's Redis claim
    // so a Redis outage cannot suppress both the Fast event and direct fallback.
    try {
      await notifyFastAgentParentOnPullRequestStatusChanged({
        run: latestRun,
        pullRequest: {
          provider: sourceControlProvider,
          repository: parsedInput.repository,
          number: parsedInput.prNumber,
          title: parsedInput.prTitle,
          url: parsedInput.prUrl,
          status: parsedInput.status,
        },
        actorLogin: parsedInput.actorLogin,
      });
    } catch (error) {
      fastDeliveryCause ??= error;
      fastFallbackTaskIds.push(taskId);
    }

    // Claim once per task so webhook redeliveries and mid-loop failures do not
    // rewrite history for tasks that already succeeded.
    const claimKey = buildStatusRecordedKey({
      sourceControlProvider,
      repository: parsedInput.repository,
      prNumber: parsedInput.prNumber,
      status: parsedInput.status,
      taskId,
    });
    let claim: Awaited<ReturnType<typeof redis.set>>;
    try {
      claim = await redis.set(
        claimKey,
        '1',
        'EX',
        STATUS_RECORDED_TTL_SECONDS,
        'NX',
      );
    } catch (error) {
      historyError ??= new PrStatusHistoryRecordingError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
      continue;
    }

    if (claim !== 'OK') {
      skippedAlreadyRecorded += 1;
      continue;
    }

    claimedTaskCount += 1;

    try {
      await recordTaskMessageEnvelope({
        runId: latestRun.id,
        taskId,
        envelope: {
          // Fresh wall-clock ms avoids second-granularity provider clock
          // collisions across distinct PR status events on the same task.
          ts: Date.now(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
          contentBlocks: [{ type: 'text', text }],
          metadata: {
            source: PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
            visibleInTranscript: true,
          },
          payload: {
            text,
            source: PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
            status: parsedInput.status,
            repository: parsedInput.repository,
            prNumber: parsedInput.prNumber,
            prUrl: parsedInput.prUrl,
            actorLogin: parsedInput.actorLogin,
          },
          visibleInTranscript: true,
        },
      });

      recordedTaskCount += 1;
    } catch (error) {
      // Release so a later webhook delivery can retry this task instead of
      // staying silent for the full TTL after a transient write failure.
      await redis.del(claimKey).catch(() => undefined);
      historyError ??= new PrStatusHistoryRecordingError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
      continue;
    }
  }

  if (fastFallbackTaskIds.length > 0) {
    throw new PrStatusFastDeliveryError(
      fastDeliveryCause instanceof Error
        ? fastDeliveryCause.message
        : String(fastDeliveryCause),
      fastFallbackTaskIds,
      { cause: fastDeliveryCause },
    );
  }

  if (historyError) {
    throw historyError;
  }

  if (recordedTaskCount === 0) {
    if (skippedAlreadyRecorded > 0 && claimedTaskCount === 0) {
      return { recordedTaskCount: 0, reason: 'already_recorded' };
    }

    return { recordedTaskCount: 0, reason: 'no_task_runs' };
  }

  return { recordedTaskCount };
}
