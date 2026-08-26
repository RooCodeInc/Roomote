import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  setTrustedRunActingUser,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  queueCommunicationMessage,
  queueCommunicationMessageOnce,
} from '@roomote/communication';
import { withContention } from '@roomote/redis';
import {
  clearLatestUserMessage,
  findActiveSlackTaskRun,
  findCompletedSlackTaskRunWithSnapshot,
  getSlackResumeLockKey,
  getSlackTaskRunWorkspacePredicate,
  queueSlackMessage,
  resolveSlackReactionNames,
} from '@roomote/slack';
import {
  ALL_REPOSITORIES,
  activeRunStatuses,
  buildFastAgentChildTaskMetadata,
  type FastAgentParent,
  getFastAgentParentFromPayload,
  RunStatus,
  SANDBOX_SNAPSHOT_EXPIRY_MS,
  TaskPayloadKind,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  type TaskPayload,
} from '@roomote/types';

import { resumeCommunicationTaskFromSnapshot } from '../communication/communication-snapshot-resume';
import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
} from '../communication/communication-task-run-lookup';
import type { PrReviewActionProvider } from './pr-review-action';

export type PrReviewFollowUpDispatchResult =
  | { outcome: 'queued'; runId: number }
  | { outcome: 'resumed'; runId: number }
  | { outcome: 'unavailable' };

type FastAgentSlackLookup = {
  taskId: string;
  slackTeamId: string;
  channelId: string;
  threadId: string;
};

function getMatchingFastAgentSlackParent(
  payload: unknown,
  input: FastAgentSlackLookup,
): FastAgentParent | null {
  const parent = getFastAgentParentFromPayload(payload);
  if (
    parent?.conversation.surface !== 'slack' ||
    parent.conversation.workspaceId !== input.slackTeamId ||
    parent.conversation.replyTarget.channelId !== input.channelId ||
    parent.conversation.replyTarget.threadId !== input.threadId
  ) {
    return null;
  }

  return parent;
}

async function findActiveFastAgentSlackTaskRun(input: FastAgentSlackLookup) {
  const [activeRun] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(taskRuns.taskId, input.taskId),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (!activeRun) {
    return null;
  }

  return getMatchingFastAgentSlackParent(activeRun.payload, input)
    ? activeRun
    : null;
}

async function findCompletedFastAgentSlackTaskRunWithSnapshot(
  input: FastAgentSlackLookup,
) {
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);
  const [completedRun] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      snapshotId: taskRuns.snapshotId,
      payload: taskRuns.payload,
      port: taskRuns.port,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(taskRuns.taskId, input.taskId),
        inArray(taskRuns.status, [RunStatus.Completed, RunStatus.Idle]),
        isNotNull(taskRuns.snapshotId),
        isNull(taskRuns.snapshotFailedAt),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
        gt(taskRuns.snapshotCreatedAt, snapshotCutoff),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (!completedRun) {
    return null;
  }

  const parent = getMatchingFastAgentSlackParent(completedRun.payload, input);
  if (!parent) {
    return null;
  }

  return { ...completedRun, parent };
}

/**
 * Delivers a prepared PR review follow-up instruction into its owning task,
 * using the originating conversation only as a secondary routing constraint.
 * Unlike typed thread replies, this action carries an immutable task binding:
 * queue into that task's live run when one exists, otherwise wake that task
 * from its snapshot. Used by button handlers and the auto-handle path.
 */
export async function dispatchPrReviewFollowUp(input: {
  provider: PrReviewActionProvider;
  taskId: string;
  channelId: string;
  threadId: string | null;
  followUpPrompt: string;
  /** Roomote user the dispatched work is attributed to. */
  actingUserId: string;
  /** Provider-native user id shown in the transcript; falls back to actingUserId. */
  providerUserId?: string;
  /**
   * Workspace identity for modern Slack runs. Verified legacy offers can omit
   * it because their immutable task binding is the routing authority.
   */
  slackTeamId?: string;
  /** Stable canonical delivery key used to deduplicate retry dispatches. */
  idempotencyKey?: string;
}): Promise<PrReviewFollowUpDispatchResult> {
  if (input.provider === 'slack') {
    return dispatchSlackFollowUp(input);
  }

  return dispatchCommunicationFollowUp(input);
}

async function dispatchSlackFollowUp(input: {
  taskId: string;
  channelId: string;
  threadId: string | null;
  followUpPrompt: string;
  actingUserId: string;
  providerUserId?: string;
  slackTeamId?: string;
  idempotencyKey?: string;
}): Promise<PrReviewFollowUpDispatchResult> {
  const threadTs = input.threadId;

  if (!threadTs) {
    return { outcome: 'unavailable' };
  }

  const queuedMessage = {
    text: input.followUpPrompt,
    user: input.providerUserId ?? input.actingUserId,
    userId: input.actingUserId,
    ts: input.idempotencyKey ?? new Date().toISOString(),
  };
  const lookupScope = input.slackTeamId
    ? { taskId: input.taskId, slackTeamId: input.slackTeamId }
    : { taskId: input.taskId };
  const threadBoundActiveRun = await findActiveSlackTaskRun(
    threadTs,
    lookupScope,
  );
  const fastAgentActiveRun =
    !threadBoundActiveRun && input.slackTeamId
      ? await findActiveFastAgentSlackTaskRun({
          taskId: input.taskId,
          slackTeamId: input.slackTeamId,
          channelId: input.channelId,
          threadId: threadTs,
        })
      : null;
  const activeRun = threadBoundActiveRun ?? fastAgentActiveRun;

  if (activeRun) {
    await setTrustedRunActingUser({
      runId: activeRun.id,
      userId: input.actingUserId,
    });
    if (input.idempotencyKey) {
      await queueCommunicationMessageOnce('slack', activeRun.id, queuedMessage);
    } else {
      await queueSlackMessage(activeRun.id, queuedMessage);
    }

    return { outcome: 'queued', runId: activeRun.id };
  }

  const threadBoundCompletedRun = await findCompletedSlackTaskRunWithSnapshot(
    threadTs,
    lookupScope,
  );
  // Fast children inherit the parent conversation but do not own its Slack
  // thread binding, so validate the persisted parent coordinates explicitly.
  const fastAgentCompletedRun =
    !threadBoundCompletedRun && input.slackTeamId
      ? await findCompletedFastAgentSlackTaskRunWithSnapshot({
          taskId: input.taskId,
          slackTeamId: input.slackTeamId,
          channelId: input.channelId,
          threadId: threadTs,
        })
      : null;
  const completedRun = threadBoundCompletedRun ?? fastAgentCompletedRun;

  if (!completedRun?.snapshotId) {
    return { outcome: 'unavailable' };
  }

  // Slim variant of the Slack snapshot resume: the follow-up prompt is
  // self-contained, so no thread-history continuation context is assembled.
  const completedPayload = completedRun.payload as Record<string, unknown>;
  const repo =
    typeof completedPayload?.repo === 'string'
      ? completedPayload.repo
      : ALL_REPOSITORIES;
  const environmentId =
    typeof completedPayload?.environmentId === 'string'
      ? completedPayload.environmentId
      : undefined;
  const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();
  const originMessageTs = (Date.now() / 1000).toFixed(6);
  const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo,
    ...(environmentId ? { environmentId } : {}),
    ...(completedRun.port ? { port: completedRun.port } : {}),
    sourceSnapshotId: completedRun.snapshotId,
    sourceRunId: completedRun.id,
    slackOriginMessageTs: originMessageTs,
    ackEmoji,
    completionEmoji,
    ...(fastAgentCompletedRun
      ? buildFastAgentChildTaskMetadata(fastAgentCompletedRun.parent)
      : {}),
  };

  populateSnapshotResumeSlackMetadata(resumePayload, {
    sourcePayload: completedPayload,
    teamId: input.slackTeamId,
    channel: input.channelId,
    threadTs,
  });
  restoreSnapshotResumeVisiblePromptFields(resumePayload, completedPayload);

  const { value: resumeRunId } = await withContention<number>(
    getSlackResumeLockKey(threadTs, input.taskId),
    {
      ttlSeconds: 30,
      poll: { intervalMs: 500, maxAttempts: 10 },
      onAcquired: async () => {
        const resumeLaunch = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.SnapshotResume,
              sourceSnapshotId: completedRun.snapshotId!,
              sourceRunId: completedRun.id,
              payload: resumePayload,
            },
            actingUserId: input.actingUserId,
          },
          {},
        );

        return resumeLaunch.id;
      },
      onContended: async () => {
        // Another resume is racing for this task; queue onto its fresh run
        // instead of dropping the follow-up. The task predicate prevents a
        // sibling task in the same thread from receiving the action.
        const [recent] = await db
          .select({ id: taskRuns.id, payload: taskRuns.payload })
          .from(taskRuns)
          .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
          .where(
            and(
              ...(fastAgentCompletedRun
                ? []
                : [eq(tasks.slackThreadTs, threadTs)]),
              eq(taskRuns.taskId, input.taskId),
              ...(input.slackTeamId && !fastAgentCompletedRun
                ? [getSlackTaskRunWorkspacePredicate(input.slackTeamId)]
                : []),
              eq(taskRuns.kind, 'resume'),
              gt(taskRuns.createdAt, new Date(Date.now() - 60_000)),
            ),
          )
          .orderBy(desc(taskRuns.createdAt))
          .limit(1);

        if (
          fastAgentCompletedRun &&
          recent &&
          !getMatchingFastAgentSlackParent(recent.payload, {
            taskId: input.taskId,
            slackTeamId: input.slackTeamId!,
            channelId: input.channelId,
            threadId: threadTs,
          })
        ) {
          return undefined;
        }

        return recent?.id;
      },
    },
  );

  if (resumeRunId === undefined) {
    return { outcome: 'unavailable' };
  }

  if (input.idempotencyKey) {
    await queueCommunicationMessageOnce('slack', resumeRunId, queuedMessage);
  } else {
    await queueSlackMessage(resumeRunId, queuedMessage);
  }
  await clearLatestUserMessage(resumeRunId);

  return { outcome: 'resumed', runId: resumeRunId };
}

async function dispatchCommunicationFollowUp(input: {
  provider: PrReviewActionProvider;
  taskId: string;
  channelId: string;
  threadId: string | null;
  followUpPrompt: string;
  actingUserId: string;
  providerUserId?: string;
  idempotencyKey?: string;
}): Promise<PrReviewFollowUpDispatchResult> {
  const provider = input.provider as 'discord' | 'telegram';
  const conversation = {
    provider,
    taskId: input.taskId,
    channelId: input.channelId,
    threadId: input.threadId ?? undefined,
  };
  const queuedMessage = {
    text: input.followUpPrompt,
    user: input.providerUserId ?? input.actingUserId,
    userId: input.actingUserId,
    ts: input.idempotencyKey ?? new Date().toISOString(),
  };
  const activeRun = await findActiveCommunicationTaskRun(conversation);

  if (activeRun) {
    await setTrustedRunActingUser({
      runId: activeRun.id,
      userId: input.actingUserId,
    });
    if (input.idempotencyKey) {
      await queueCommunicationMessageOnce(
        provider,
        activeRun.id,
        queuedMessage,
      );
    } else {
      await queueCommunicationMessage(provider, activeRun.id, queuedMessage);
    }

    return { outcome: 'queued', runId: activeRun.id };
  }

  const completedRun =
    await findCompletedCommunicationTaskRunWithSnapshot(conversation);

  if (!completedRun?.snapshotId) {
    return { outcome: 'unavailable' };
  }

  const resumed = await resumeCommunicationTaskFromSnapshot({
    provider,
    completedRun,
    queuedMessage: { ...queuedMessage, provider },
    channelId: input.channelId,
    threadId: input.threadId ?? undefined,
    preservePayloadFlags:
      provider === 'telegram' ? ['telegramTaskTopic'] : ['discordTaskThread'],
  });

  return { outcome: 'resumed', runId: resumed.id };
}
