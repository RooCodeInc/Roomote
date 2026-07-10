import { Env } from '@roomote/env';
import type { SlackInstallation } from '@roomote/db/server';
import {
  AGENT_DISPLAY_NAME,
  type ChannelAutoStartLaunchMode,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  type ReasoningEffort,
  type TaskInitiator,
  type TaskTrigger,
  type TaskVisibility,
  type TaskWorkflow,
} from '@roomote/types';
import {
  appendAttachmentTextsToPromptText,
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';
import {
  buildSlackRoutingContext,
  detectSlackMcpSetupRequirement,
  extractPromptTextAttachments,
  getTaskUrl,
  routeTask,
  type RoutingResult,
} from '@roomote/cloud-agents/server';

import {
  mapRoutingWorkspaceToSelectionValue,
  resolveWorkspace,
} from './block-kit';
import { finishRoutedStart } from './started-message';
import { SlackNotifier } from './slack-notifier';
import { getPromptReadyThreadMessages } from './prompt-ready-thread-messages';
import { startSlackAppMentionTask } from './start-slack-app-mention';
import { SlackThreadDeliveryTracker } from './slack-thread-delivery-tracker';
import {
  collectAndExtractThreadAttachmentTexts,
  collectAndProcessThreadImages,
} from './thread-image-utils';
import type { SlackThreadMessage } from './types';
import { appendSlackVideoDescriptionsToText } from './video-descriptions';

type SlackTaskStartFailureCode =
  | 'source_message_missing'
  | 'source_message_inaccessible'
  | 'launch_message_failed'
  | 'mcp_setup_required'
  | 'routing_fallback'
  | 'workspace_unavailable';

export type StartAutoRoutedSlackTaskResult =
  | {
      status: 'started';
      threadId: string;
      cloudJobId: number | null;
      taskId: string | null;
      taskUrl?: string;
    }
  | {
      status: 'replied_inline';
      threadId: string;
      message: string;
    }
  | {
      status: 'not_started';
      code: SlackTaskStartFailureCode;
      threadId: string;
      message: string;
      routingResult?: RoutingResult;
    };

function getNextSlackTimestamp(ts: string): string {
  const [secondsPartRaw, fractionalPart = ''] = ts.split('.', 2);
  const secondsPart = secondsPartRaw ?? '';
  const seconds = Number.parseInt(secondsPart, 10);
  const micros = Number.parseInt(
    fractionalPart.padEnd(6, '0').slice(0, 6) || '0',
    10,
  );

  if (!Number.isFinite(seconds) || !Number.isFinite(micros)) {
    return ts;
  }

  const nextMicros = micros + 1;

  if (nextMicros >= 1_000_000) {
    return `${seconds + 1}.000000`;
  }

  return `${seconds}.${String(nextMicros).padStart(6, '0')}`;
}

function getLatestSlackTimestamp(
  timestamps: string[],
  fallback: string,
): string {
  return timestamps.reduce((latest, candidate) => {
    return Number(candidate) > Number(latest) ? candidate : latest;
  }, fallback);
}

function buildRoutingFallbackRequiresPickerResult(
  threadId: string,
): StartAutoRoutedSlackTaskResult {
  return {
    status: 'not_started',
    code: 'routing_fallback',
    threadId,
    message: 'Slack auto-routing needs manual environment selection.',
  };
}

export async function startAutoRoutedSlackTask({
  slackInstallation,
  slack,
  initiator,
  trigger,
  workflow,
  visibility,
  launchUserId,
  slackUserId,
  persistedSlackUserId,
  initiatingSlackUserId,
  channel,
  prompt,
  threadTs,
  originMessageTs,
  processedImages,
  processedAttachmentTexts,
  processedImageFileIds,
  processedAttachmentFileIds,
  processedVideoDescriptions,
  agentPromptPrefix,
  agentPromptTextOverride,
  ackEmoji,
  completionEmoji,
  routingRepositoryConstraint,
  webPath,
  branch,
  sha,
  harness,
  model,
  reasoningEffort,
  skipMcpSetupInterrupt = false,
  channelAutoStartLaunchMode:
    _channelAutoStartLaunchMode = DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
}: {
  slackInstallation: Pick<
    SlackInstallation,
    'botUserId' | 'teamId' | 'teamDomain'
  >;
  slack: SlackNotifier;
  /** Forwarded verbatim to startSlackAppMentionTask / enqueueCloudTask. */
  initiator: TaskInitiator;
  trigger: TaskTrigger;
  workflow?: Extract<TaskWorkflow, 'standard' | 'eval'>;
  visibility?: TaskVisibility;
  /**
   * Linked launching user for routing context, MCP-setup detection, and
   * last-workspace memory. Omit for automation initiators (bot-authored
   * channel auto-start); identity for attribution lives on `initiator`.
   */
  launchUserId?: string | null;
  slackUserId: string;
  persistedSlackUserId?: string | null;
  initiatingSlackUserId?: string;
  channel: string;
  prompt: string;
  threadTs?: string;
  originMessageTs?: string;
  processedImages?: string[];
  processedAttachmentTexts?: string[];
  processedImageFileIds?: string[];
  processedAttachmentFileIds?: string[];
  processedVideoDescriptions?: string[];
  agentPromptPrefix?: string;
  agentPromptTextOverride?: string;
  ackEmoji?: string;
  completionEmoji?: string;
  routingRepositoryConstraint?: string;
  webPath?: string;
  branch?: string;
  sha?: string;
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  skipMcpSetupInterrupt?: boolean;
  channelAutoStartLaunchMode?: ChannelAutoStartLaunchMode;
}): Promise<StartAutoRoutedSlackTaskResult> {
  let threadId = threadTs ?? '';
  let deliveryTracker: SlackThreadDeliveryTracker | null = null;

  try {
    if (threadId) {
      const selectedMessageExists = await slack.hasMessageInThread({
        channel,
        threadTs: threadId,
        messageTs: threadId,
      });

      if (selectedMessageExists === false) {
        return {
          status: 'not_started',
          code: 'source_message_missing',
          threadId,
          message:
            'The target Slack thread is no longer available, so the task was not started.',
        };
      }

      if (selectedMessageExists === null) {
        const appInChannel = await slack.isAppInChannel(channel);

        if (appInChannel === false) {
          return {
            status: 'not_started',
            code: 'source_message_inaccessible',
            threadId,
            message:
              'Roomote could not access the target Slack thread. Make sure the Roomote app is still in that channel and try again.',
          };
        }

        console.warn(
          `[startAutoRoutedSlackTask] Could not verify access to Slack thread ${channel}:${threadId}; continuing without blocking task launch`,
        );
      }
    }

    const taskDescription = stripLeadingSlackProductMention(
      await slack.normalizeIncomingText(stripLeadingRawSlackMention(prompt)),
    );

    if (!skipMcpSetupInterrupt && launchUserId) {
      const setupRequirement = await detectSlackMcpSetupRequirement(
        taskDescription,
        {
          userId: launchUserId,
          apiBaseUrl: Env.ROOMOTE_APP_URL,
        },
      );

      if (setupRequirement) {
        return {
          status: 'not_started',
          code: 'mcp_setup_required',
          threadId,
          message: `Task was not started because ${setupRequirement.serviceName} still needs Slack MCP setup.`,
        };
      }
    }

    let threadMessages: SlackThreadMessage[] | undefined;
    let latestOwnBotReply:
      | { ts: string; text: string; displayName: string }
      | undefined;

    if (threadTs) {
      try {
        const splitMessages = await getPromptReadyThreadMessages({
          slack,
          channel,
          threadTs: threadId,
          botUserId: slackInstallation.botUserId,
        });
        threadMessages = splitMessages.contextMessages;
        latestOwnBotReply = splitMessages.latestOwnBotReply;
      } catch (error) {
        console.warn(
          `[startAutoRoutedSlackTask] Failed to fetch thread messages for ${channel}:${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const processedFileIds = [
      ...(processedImageFileIds ?? []),
      ...(processedAttachmentFileIds ?? []),
    ];
    const excludeFileIds =
      processedFileIds.length > 0 ? new Set(processedFileIds) : undefined;
    const [threadImages, threadAttachmentTexts] = threadMessages
      ? await Promise.all([
          collectAndProcessThreadImages({
            processSlackFiles: (files) => slack.processSlackFiles(files),
            messages: threadMessages,
            excludeFileIds,
            logContext: `startAutoRoutedSlackTask ${channel}:${threadId}`,
          }),
          collectAndExtractThreadAttachmentTexts({
            extractSlackAttachmentTexts: async (files) =>
              extractPromptTextAttachments(
                (
                  await Promise.all(
                    files.map(async (file) => {
                      const fileBytes = await slack.downloadSlackFile(file);
                      return fileBytes
                        ? {
                            filename: file.name,
                            mimeType: file.mimetype,
                            bytes: fileBytes,
                          }
                        : null;
                    }),
                  )
                ).filter(
                  (input): input is NonNullable<typeof input> => input !== null,
                ),
              ).then((result) => {
                for (const warning of result.warnings) {
                  console.warn(
                    `[startAutoRoutedSlackTask] Attachment extraction warning: ${warning}`,
                  );
                }
                return result.attachmentTexts;
              }),
            messages: threadMessages,
            excludeFileIds,
            logContext: `startAutoRoutedSlackTask ${channel}:${threadId}`,
          }),
        ])
      : [[], []];
    const allProcessedImages = [...(processedImages ?? []), ...threadImages];
    const allAttachmentTexts = [
      ...(processedAttachmentTexts ?? []),
      ...threadAttachmentTexts,
    ];
    const taskDescriptionWithAttachments = appendAttachmentTextsToPromptText({
      text: taskDescription,
      attachmentTexts: allAttachmentTexts,
    });

    const channelName = (await slack.getChannelName?.(channel)) ?? undefined;

    const routingContext = await buildSlackRoutingContext({
      userId: launchUserId ?? undefined,
      taskDescription: taskDescriptionWithAttachments,
      channelName,
      threadMessages: threadMessages?.map((message) => ({
        text: message.text,
        user: message.user,
      })),
      ...(allProcessedImages.length ? { images: allProcessedImages } : {}),
      ...(processedVideoDescriptions?.length
        ? { videoDescriptions: processedVideoDescriptions }
        : {}),
      apiBaseUrl: Env.TRPC_URL,
    });
    const normalizedRoutingRepositoryConstraint =
      routingRepositoryConstraint?.trim().toLowerCase() || null;
    const constrainedRoutingContext = normalizedRoutingRepositoryConstraint
      ? {
          ...routingContext,
          availableEnvironments: routingContext.availableEnvironments.filter(
            (environment) =>
              environment.repositoryNames.some(
                (repositoryName) =>
                  repositoryName.toLowerCase() ===
                  normalizedRoutingRepositoryConstraint,
              ),
          ),
        }
      : routingContext;

    const decision = await routeTask(constrainedRoutingContext);

    if (decision.status === 'platform_answer') {
      return buildRoutingFallbackRequiresPickerResult(threadId);
    }

    if (decision.status !== 'routed') {
      return buildRoutingFallbackRequiresPickerResult(threadId);
    }

    const workspaceValue = mapRoutingWorkspaceToSelectionValue(
      decision.result.workspace,
    );
    const workspace = await resolveWorkspace(workspaceValue);

    if (!workspace) {
      return {
        status: 'not_started',
        code: 'workspace_unavailable',
        threadId,
        message:
          'Task was not started because the routed launch target could not be resolved.',
        routingResult: decision.result,
      };
    }

    let existingMessageTs: string | undefined;
    if (!threadId) {
      existingMessageTs = await slack.postMessage({
        channel,
        text: 'Roomote is starting your task...',
      });

      if (!existingMessageTs) {
        return {
          status: 'not_started',
          code: 'launch_message_failed',
          threadId: '',
          message:
            'Roomote could not post the task start message. Make sure the Roomote app can post in that channel.',
        };
      }

      threadId = existingMessageTs;
    }

    const sourceMessageTs =
      originMessageTs?.trim() ||
      existingMessageTs ||
      getNextSlackTimestamp(
        getLatestSlackTimestamp(
          threadMessages?.map((message) => message.ts) ?? [],
          threadId,
        ),
      );
    deliveryTracker = new SlackThreadDeliveryTracker(channel, threadId);
    const taskTextWithVideos = appendSlackVideoDescriptionsToText({
      text: taskDescriptionWithAttachments,
      videoDescriptions: processedVideoDescriptions,
    });
    const taskText = taskTextWithVideos;
    const trimmedAgentPromptTextOverride = agentPromptTextOverride?.trim();
    const trimmedAgentPromptPrefix = agentPromptPrefix?.trim();
    const agentPromptText =
      trimmedAgentPromptTextOverride ||
      (trimmedAgentPromptPrefix
        ? `${trimmedAgentPromptPrefix}\n\n${taskText}`
        : undefined);
    const slackConversationUrl =
      (await slack.getMessagePermalink?.({
        channel,
        messageTs: threadId,
      })) ?? null;
    const cloudJob = await startSlackAppMentionTask({
      initiator,
      trigger,
      workflow,
      visibility,
      channel,
      teamId: slackInstallation.teamId,
      teamDomain: slackInstallation.teamDomain ?? undefined,
      slackUserId,
      persistedSlackUserId,
      text: taskText,
      agentPromptText,
      ackEmoji,
      completionEmoji,
      ts: sourceMessageTs,
      threadTs: threadId,
      repo: workspace.repoForPayload,
      branch,
      sha,
      harness,
      model: model ?? decision.result.model?.id,
      environmentId: workspace.environmentId,
      reasoningEffort,
      images: allProcessedImages.length ? allProcessedImages : undefined,
      threadMessages,
      latestOwnBotReplyText: latestOwnBotReply?.text,
      latestOwnBotReplyTs: latestOwnBotReply?.ts,
      webPath,
      slackConversationUrl: slackConversationUrl ?? undefined,
      skipInitialActingUser: true,
      ...(existingMessageTs
        ? {
            queuedStartedMessage: {
              ts: existingMessageTs,
              agentName: AGENT_DISPLAY_NAME,
              initiatingSlackUserId,
              workspaceDisplayName: workspace.workspaceDisplayName,
              ...(decision.result.model?.displayName
                ? { modelDisplayName: decision.result.model.displayName }
                : {}),
              workspaceOnly: decision.result.workspaceOnly,
            },
          }
        : {}),
    });

    if (existingMessageTs) {
      deliveryTracker.track(existingMessageTs);
    }
    deliveryTracker.trackAll(
      threadMessages?.map((message) => message.ts) ?? [],
    );

    if (cloudJob.reusedExistingJob) {
      return {
        status: 'started',
        threadId,
        cloudJobId: cloudJob.id,
        taskId: cloudJob.taskId,
        taskUrl: cloudJob.taskId
          ? getTaskUrl({
              taskId: cloudJob.taskId,
              utm: { source: 'slack', campaign: 'workflow_step' },
            })
          : undefined,
      };
    }

    await finishRoutedStart({
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
      taskDescription: taskText,
      userId: launchUserId,
      initiatingSlackUserId,
      agentName: AGENT_DISPLAY_NAME,
      workspaceDisplayName: workspace.workspaceDisplayName,
      modelDisplayName: decision.result.model?.displayName,
      workspaceType: decision.result.workspace.type,
      workspaceValue,
      workspaceOnly: decision.result.workspaceOnly,
      channel,
      threadId,
      teamDomain: slackInstallation.teamDomain ?? undefined,
      existingMessageTs,
      reasoning: decision.result.reasoning,
      routingDebug: decision.result.debug,
      slack,
    });

    return {
      status: 'started',
      threadId,
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
      taskUrl: cloudJob.taskId
        ? getTaskUrl({
            taskId: cloudJob.taskId,
            utm: { source: 'slack', campaign: 'workflow_step' },
          })
        : undefined,
    };
  } finally {
    if (deliveryTracker) {
      await deliveryTracker.commit();
    }
  }
}
