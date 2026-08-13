import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  desc,
  eq,
  gt,
  setTrustedRunActingUser,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { queueCommunicationMessage } from '@roomote/communication';
import { withContention } from '@roomote/redis';
import {
  clearLatestUserMessage,
  findActiveSlackTaskRun,
  findCompletedSlackTaskRunWithSnapshot,
  getSlackResumeLockKey,
  queueSlackMessage,
  resolveSlackReactionNames,
} from '@roomote/slack';
import {
  ALL_REPOSITORIES,
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
}): Promise<PrReviewFollowUpDispatchResult> {
  const threadTs = input.threadId;

  if (!threadTs) {
    return { outcome: 'unavailable' };
  }

  const queuedMessage = {
    text: input.followUpPrompt,
    user: input.providerUserId ?? input.actingUserId,
    userId: input.actingUserId,
    ts: new Date().toISOString(),
  };
  const activeRun = await findActiveSlackTaskRun(threadTs, input.taskId);

  if (activeRun) {
    await setTrustedRunActingUser({
      runId: activeRun.id,
      userId: input.actingUserId,
    });
    await queueSlackMessage(activeRun.id, queuedMessage);

    return { outcome: 'queued', runId: activeRun.id };
  }

  const completedRun = await findCompletedSlackTaskRunWithSnapshot(
    threadTs,
    input.taskId,
  );

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
  };

  populateSnapshotResumeSlackMetadata(resumePayload, {
    sourcePayload: completedPayload,
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
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
          .where(
            and(
              eq(tasks.slackThreadTs, threadTs),
              eq(taskRuns.taskId, input.taskId),
              eq(taskRuns.kind, 'resume'),
              gt(taskRuns.createdAt, new Date(Date.now() - 60_000)),
            ),
          )
          .orderBy(desc(taskRuns.createdAt))
          .limit(1);

        return recent?.id;
      },
    },
  );

  if (resumeRunId === undefined) {
    return { outcome: 'unavailable' };
  }

  await queueSlackMessage(resumeRunId, queuedMessage);
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
    ts: new Date().toISOString(),
  };
  const activeRun = await findActiveCommunicationTaskRun(conversation);

  if (activeRun) {
    await setTrustedRunActingUser({
      runId: activeRun.id,
      userId: input.actingUserId,
    });
    await queueCommunicationMessage(provider, activeRun.id, queuedMessage);

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
