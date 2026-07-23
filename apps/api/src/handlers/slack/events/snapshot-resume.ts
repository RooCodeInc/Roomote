import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import { withContention } from '@roomote/redis';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  appendSlackVideoDescriptionsToText,
  clearLatestUserMessage,
  collectAndProcessThreadImages,
  getPromptReadyThreadMessages,
  getLatestSlackBotReply,
  queueSlackMessage,
  resolveCurrentSlackMessageFiles,
  SlackThreadDeliveryTracker,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';
import { and, db, desc, eq, gt, taskRuns, tasks } from '@roomote/db/server';
import {
  appendAttachmentTextsToPromptText,
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';

import { apiLogger } from '../../../logging.js';
import { retireSlackPrReviewOffersBestEffort } from '../pr-review-retire.js';
import {
  buildResolvedCurrentMessageText,
  processSlackAttachments,
} from '../helpers/attachments.js';
import { getIsSlackDiverged } from '../helpers/thread-sync.js';

type CompletedSlackTaskRun = {
  id: number;
  actingUserId: string | null;
  snapshotId: string | null;
  payload: unknown;
  port: number | null;
};

export async function processSnapshotResume(
  event: SlackEvent,
  slack: SlackNotifier,
  completedRun: CompletedSlackTaskRun,
  threadId: string,
  userId: string | null,
  ackEmoji: string,
  completionEmoji: string,
  botUserId?: string,
): Promise<boolean> {
  const deliveryTracker = new SlackThreadDeliveryTracker(
    event.channel,
    threadId,
  );
  const completedPayload = completedRun.payload as Record<string, unknown>;
  const repo =
    typeof completedPayload?.repo === 'string'
      ? completedPayload.repo
      : ALL_REPOSITORIES;
  const environmentId =
    typeof completedPayload?.environmentId === 'string'
      ? completedPayload.environmentId
      : undefined;
  const logContext = `snapshot resume task run in ${event.channel}:${threadId}`;

  const [promptReadyThreadMessages, normalizedMessageText, trackedBotReply] =
    await Promise.all([
      getPromptReadyThreadMessages({
        slack,
        channel: event.channel,
        threadTs: threadId,
        botUserId,
        startedMessageRunId: completedRun.id,
        logContext,
      }),
      slack.normalizeIncomingText(stripLeadingRawSlackMention(event.text)),
      getLatestSlackBotReply(event.channel, threadId),
    ]);
  const messageText = stripLeadingSlackProductMention(normalizedMessageText);
  const currentMessageFiles = resolveCurrentSlackMessageFiles({
    currentMessageTs: event.ts,
    eventFiles: event.files,
    messages: promptReadyThreadMessages.messages,
  });
  const promptRelevantThreadMessages =
    promptReadyThreadMessages.promptRelevantMessages;
  const attachments = await processSlackAttachments({
    slack,
    files: currentMessageFiles,
    userId: completedRun.actingUserId ?? undefined,
    userTextContext: stripLeadingSlackProductMention(
      stripLeadingRawSlackMention(event.text),
    ),
  });
  const currentMessageTextWithVideoDescriptions =
    appendSlackVideoDescriptionsToText({
      text: appendAttachmentTextsToPromptText({
        text: messageText,
        attachmentTexts: attachments.attachmentTexts,
      }),
      videoDescriptions: attachments.videoDescriptions,
    });
  const excludeFileIds = currentMessageFiles
    ? new Set(currentMessageFiles.map((file) => file.id))
    : undefined;
  const isSlackDiverged = await getIsSlackDiverged({
    runId: completedRun.id,
    trackedBotReply,
  });
  const {
    currentMessageText: messageTextWithVideoDescriptions,
    claimedImageUris,
    formattedPrompt,
    turnPolicy,
  } = await deliveryTracker.buildContinuationPrompt({
    currentMessageTs: event.ts,
    currentMessageText: currentMessageTextWithVideoDescriptions,
    resolveCurrentMessageText: (claimedMessages) =>
      buildResolvedCurrentMessageText({
        slack,
        claimedMessages,
        excludeFileIds,
        logContext,
        userId: completedRun.actingUserId ?? undefined,
        messageText,
        currentAttachmentTexts: attachments.attachmentTexts,
        currentVideoDescriptions: attachments.videoDescriptions,
      }),
    fetchThreadMessages: async () => promptRelevantThreadMessages,
    normalizeMessageText: (text) => slack.normalizeIncomingText(text),
    processMessageFiles: (messages) =>
      collectAndProcessThreadImages({
        processSlackFiles: (files) => slack.processSlackFiles(files),
        messages,
        excludeFileIds,
        logContext,
      }),
    getTrackedBotReply: async () => trackedBotReply,
    isSlackDiverged,
    botUserId,
  });

  try {
    const allImages = [...attachments.images, ...claimedImageUris];
    const queuedSlackMessage = {
      text: messageTextWithVideoDescriptions,
      user: event.user,
      userId: userId ?? undefined,
      ts: event.ts,
      images: allImages.length > 0 ? allImages : undefined,
      formattedPrompt,
      turnPolicy,
    };
    const payloadBase = {
      repo,
      environmentId,
      port: completedRun.port ?? undefined,
      sourceSnapshotId: completedRun.snapshotId!,
      sourceRunId: completedRun.id,
      slackOriginMessageTs: event.ts,
      ackEmoji,
      completionEmoji,
    };

    const directPayload = { ...payloadBase };
    populateSnapshotResumeSlackMetadata(directPayload, {
      sourcePayload: completedPayload,
      channel: event.channel,
      threadTs: threadId,
    });
    restoreSnapshotResumeVisiblePromptFields(directPayload, completedPayload);

    const { value: resumeRunId } = await withContention<number>(
      `slack:resume-lock:${threadId}`,
      {
        ttlSeconds: 30,
        poll: { intervalMs: 500, maxAttempts: 10 },
        onAcquired: async () => {
          // Resumes never create tasks and never re-attribute; the Slack
          // follow-up sender becomes the new run's acting user.
          const resumeLaunch = await enqueueTask(
            {
              task: {
                type: TaskPayloadKind.SnapshotResume,
                sourceSnapshotId: completedRun.snapshotId!,
                sourceRunId: completedRun.id,
                payload: directPayload,
              },
              actingUserId: userId,
            },
            {},
          );

          apiLogger.debug(
            `✅ Created SnapshotResume task run ${resumeLaunch.id} for thread ${threadId}`,
          );

          return resumeLaunch.id;
        },
        onContended: async () => {
          // Slack channel bindings live on tasks; resume runs are the
          // kind='resume' rows of the bound task.
          const [recent] = await db
            .select({ id: taskRuns.id })
            .from(taskRuns)
            .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
            .where(
              and(
                eq(tasks.slackThreadTs, threadId),
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
      return false;
    }

    await queueSlackMessage(resumeRunId, queuedSlackMessage);
    await clearLatestUserMessage(resumeRunId);
    // A typed reply supersedes any pending PR review offers in the thread.
    retireSlackPrReviewOffersBestEffort({
      slack,
      channelId: event.channel,
      threadTs: threadId,
    });
    deliveryTracker.track(event.ts);
    return true;
  } catch (error) {
    await deliveryTracker.rollback().catch(() => {});
    throw error;
  } finally {
    await deliveryTracker.commit();
  }
}
