import {
  type TaskPayload,
  type SlackBlock,
  TaskPayloadKind,
  DEFAULT_SLACK_ACK_EMOJI,
  PRODUCT_NAME,
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';
import {
  SlackNotifier,
  buildSlackRequestUserInputBlocks,
  buildStartedBlocks,
  convertMarkdownToSlack,
} from '@roomote/slack/client';
import { type TaskRun, sdk } from '@roomote/sdk/client';
import { FeatureFlag } from '@roomote/feature-flags';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';
import { captureWorkerException } from '../monitoring/sentry';
import {
  buildRequestUserInputTaskUrl,
  getRequestUserInputPromptSignature,
  supportsIntegrationRequestUserInput,
} from './request-user-input';

function reportSlackCallbackError(
  error: unknown,
  stage: string,
  runId: number,
): void {
  captureWorkerException(error, {
    runId,
    stage,
  });
}

function getRequestUserInputLinkLabel(url: string): string {
  try {
    return new URL(url).pathname === '/setup' ? 'Open setup' : 'Open task';
  } catch {
    return 'Open task';
  }
}

function getRequestUserInputPromptSignatures(
  context: RunTaskContext,
): Map<string, string> {
  const existing = context.postedRequestUserInputSignatures;

  if (existing instanceof Map) {
    return existing as Map<string, string>;
  }

  const next = new Map<string, string>();
  context.postedRequestUserInputSignatures = next;
  return next;
}

function getSlackRequestUserInputPromptMessageTs(
  context: RunTaskContext,
): Map<string, string> {
  const existing = context.slackRequestUserInputPromptMessageTs;

  if (existing instanceof Map) {
    return existing as Map<string, string>;
  }

  const next = new Map<string, string>();
  context.slackRequestUserInputPromptMessageTs = next;
  return next;
}

function getInitiatingSlackUserIdForStartedMessage(
  taskRun: TaskRun,
  startedData: {
    initiatingSlackUserId?: string;
  },
): string | undefined {
  if (startedData.initiatingSlackUserId) {
    return startedData.initiatingSlackUserId;
  }

  const payload = taskRun.payload;

  if (
    taskRun.payloadKind === TaskPayloadKind.SlackAppMention &&
    payload &&
    typeof payload === 'object' &&
    'user' in payload &&
    typeof payload.user === 'string'
  ) {
    return payload.user;
  }

  return undefined;
}

async function recordOutboundSlackMessageForTaskRun(params: {
  taskRun: TaskRun;
  messageTs: string | null | undefined;
  text: string;
  source: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.messageTs) {
    return;
  }

  const { channel, thread_ts: threadTs } = getSlackConversation(params.taskRun);

  await sdk.taskRuns.recordOutboundSlackConversationMessage({
    runId: params.taskRun.id,
    slackChannelId: channel,
    conversationKind: 'thread',
    threadTs,
    messageTs: params.messageTs,
    source: params.source,
    text: params.text,
    metadata: params.metadata,
  });
}

export const slackMentionCallbacks: RunTaskCallbacks = {
  onStart: async (
    taskRun: TaskRun,
    taskId: string,
    context: RunTaskContext,
  ) => {
    if (!context.sessionId) {
      context.sessionId = taskId;
    }
    const slack = await getSlackNotifier();

    try {
      await removeSlackAckReaction(taskRun, slack);
    } catch (error) {
      reportSlackCallbackError(
        error,
        'slackMentionCallbacks.onStart.removeReaction',
        taskRun.id,
      );
      console.error(
        `[slackMentionCallbacks#onStart] Failed Slack reaction cleanup for task run ${taskRun.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      // Build a single task URL that includes preview params for the primary service.
      const taskUrlObj = new URL(
        `/task/${taskRun.taskId}`,
        process.env.R_APP_URL,
      );
      taskUrlObj.searchParams.set('utm_source', 'slack');
      taskUrlObj.searchParams.set('utm_medium', 'link');
      taskUrlObj.searchParams.set('utm_campaign', 'slack.app.mention');

      // Retrieve the started message metadata so we can rebuild the blocks.
      const startedData = await sdk.taskRuns.getSlackStartedMessageData({
        runId: taskRun.id,
      });

      if (!startedData) {
        console.log(
          `[slackMentionCallbacks#onStart] No started message data for job ${taskRun.id}, skipping Follow button`,
        );

        return;
      }

      const taskUrl = taskUrlObj.toString();
      const initiatingSlackUserId = getInitiatingSlackUserIdForStartedMessage(
        taskRun,
        startedData,
      );

      // Rebuild the started message blocks with the Follow button included
      let freeformKickoffEnabled = false;
      try {
        freeformKickoffEnabled = await sdk.featureFlags.evaluate(
          FeatureFlag.DynamicKickoffMessage,
        );
      } catch {
        freeformKickoffEnabled = false;
      }

      const blocks = buildStartedBlocks({
        workspaceDisplayName: startedData.workspaceDisplayName,
        modelDisplayName: startedData.modelDisplayName,
        kickoffMessage: freeformKickoffEnabled
          ? startedData.kickoffMessage
          : undefined,
        freeformKickoffEnabled,
        runId: taskRun.id,
        otherRunningTasksCount: startedData.otherRunningTasksCount,
        taskId: taskRun.taskId,
        initiatingSlackUserId,
        taskUrl,
      });

      const { channel, thread_ts: threadTs } = getSlackConversation(taskRun);

      if (threadTs) {
        await slack.updateMessage({
          channel,
          ts: startedData.ts,
          message: { blocks },
        });
      }
    } catch (error) {
      reportSlackCallbackError(
        error,
        'slackMentionCallbacks.onStart.refreshStartedMessage',
        taskRun.id,
      );
      console.error(
        `[slackMentionCallbacks#onStart] Failed Slack started-message refresh for task run ${taskRun.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
  onMessage: async (
    taskRun: TaskRun,
    _taskId: string,
    event: CallbackEvent,
    context: RunTaskContext,
  ) => {
    if (event.type === 'completion') {
      await handleCompletion(taskRun, event, context);
    }

    if (event.type === 'request_user_input') {
      await handleRequestUserInput(taskRun, event, context);
    }

    if (event.type === 'request_user_input_response') {
      await handleRequestUserInputResponse(taskRun, event);
    }

    if (event.type === 'followup') {
      await handleFollowup(taskRun, event, context);
    }
  },
  onExit: async (taskRun: TaskRun) => {
    try {
      const { thread_ts: threadTs } = getSlackConversation(taskRun);
      await sdk.taskRuns.clearPendingSlackRequestUserInput({
        runId: taskRun.id,
        threadId: threadTs,
      });
    } catch (error) {
      reportSlackCallbackError(
        error,
        'slackMentionCallbacks.onExit.clearPendingRequestUserInput',
        taskRun.id,
      );
      console.error(
        `[slackMentionCallbacks#onExit] Failed to clear pending request_user_input state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};

async function handleCompletion(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'completion' },
  context: RunTaskContext,
) {
  if (context.completionTs === event.ts) {
    return;
  }

  context.completionTs = event.ts;
  context.isCompleted = true;

  try {
    await sdk.taskRuns.enqueueSlackPrInactivityCheck({
      runId: taskRun.id,
      completionText: event.text,
    });
  } catch (error) {
    reportSlackCallbackError(
      error,
      'slackMentionCallbacks.handleCompletion.enqueueSlackPrInactivityCheck',
      taskRun.id,
    );
    console.error(
      `[RunTaskCallbacks#onMessage -> completion, ts=${event.ts}] Failed to enqueue Slack PR inactivity check: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function handleRequestUserInput(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'request_user_input' },
  context: RunTaskContext,
) {
  const postedSignatures = getRequestUserInputPromptSignatures(context);
  const promptMessageTsByRequestId =
    getSlackRequestUserInputPromptMessageTs(context);
  const promptSignature = getRequestUserInputPromptSignature(event.request);

  if (postedSignatures.get(event.request.requestId) === promptSignature) {
    return;
  }

  try {
    const slack = await getSlackNotifier();
    const { channel, thread_ts: threadTs } = getSlackConversation(taskRun);
    const taskUrl = buildRequestUserInputTaskUrl(taskRun, 'slack');
    const supportsSlackRequestUserInput = supportsIntegrationRequestUserInput(
      event.request,
    );
    const pendingRequest = {
      runId: taskRun.id,
      threadId: threadTs,
      requestId: event.request.requestId,
      taskId: taskRun.taskId,
      questions: event.request.questions,
    };

    if (supportsSlackRequestUserInput) {
      await sdk.taskRuns.setPendingSlackRequestUserInput(pendingRequest);
      const footerText = await sdk.taskRuns.getSlackThreadFooterText({
        runId: taskRun.id,
        slackChannelId: channel,
        threadTs,
        taskUrl,
      });
      const promptBlocks = buildSlackRequestUserInputBlocks({
        requestId: event.request.requestId,
        questions: event.request.questions,
        footerText,
      });
      const existingPromptMessageTs = promptMessageTsByRequestId.get(
        event.request.requestId,
      );
      const didUpdatePrompt = existingPromptMessageTs
        ? await slack.updateMessage({
            channel,
            ts: existingPromptMessageTs,
            message: { blocks: promptBlocks },
          })
        : false;

      const promptMessageTs = didUpdatePrompt
        ? existingPromptMessageTs
        : await slack.postMessage({
            channel,
            thread_ts: threadTs,
            blocks: promptBlocks,
          });

      if (!promptMessageTs) {
        await sdk.taskRuns.clearPendingSlackRequestUserInput({
          runId: taskRun.id,
          threadId: threadTs,
          requestId: event.request.requestId,
        });
        return;
      }

      await sdk.taskRuns.setPendingSlackRequestUserInput({
        ...pendingRequest,
        promptMessageTs,
      });

      promptMessageTsByRequestId.set(event.request.requestId, promptMessageTs);
      postedSignatures.set(event.request.requestId, promptSignature);

      if (!didUpdatePrompt) {
        await recordOutboundSlackMessageForTaskRun({
          taskRun,
          messageTs: promptMessageTs,
          text: 'Posted structured request_user_input prompt in Slack.',
          source: 'request_user_input',
        });
      }
      return;
    }

    const handoffMessageTs = await slack.postMessage({
      channel,
      thread_ts: threadTs,
      blocks: [
        {
          type: 'markdown' as const,
          text: `I need a private answer before I can continue. Please answer in ${PRODUCT_NAME}: <${taskUrl}|${getRequestUserInputLinkLabel(taskUrl)}>.`,
        },
      ],
    });
    if (handoffMessageTs) {
      postedSignatures.set(event.request.requestId, promptSignature);
    }
    await recordOutboundSlackMessageForTaskRun({
      taskRun,
      messageTs: handoffMessageTs,
      text: `I need a private answer before I can continue. Please answer in ${PRODUCT_NAME}: ${taskUrl}`,
      source: 'request_user_input_handoff',
    });
  } catch (error) {
    reportSlackCallbackError(
      error,
      'slackMentionCallbacks.handleRequestUserInput.postPrompt',
      taskRun.id,
    );
    console.error(
      `Failed to post request_user_input fallback to Slack: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleRequestUserInputResponse(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'request_user_input_response' },
) {
  try {
    const { thread_ts: threadTs } = getSlackConversation(taskRun);

    await sdk.taskRuns.clearPendingSlackRequestUserInput({
      runId: taskRun.id,
      threadId: threadTs,
      requestId: event.response.requestId,
    });
  } catch (error) {
    reportSlackCallbackError(
      error,
      'slackMentionCallbacks.handleRequestUserInputResponse.clearPendingState',
      taskRun.id,
    );
    console.error(
      `Failed to clear Slack request_user_input state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFollowup(
  taskRun: TaskRun,
  event: CallbackEvent & { type: 'followup' },
  context: RunTaskContext,
) {
  if (!context.postedFollowupTs) {
    context.postedFollowupTs = new Set<number>();
  }

  const postedFollowupTs = context.postedFollowupTs as Set<number>;

  if (postedFollowupTs.has(event.ts)) {
    return;
  }

  postedFollowupTs.add(event.ts);

  try {
    const blocks: SlackBlock[] = [
      {
        type: 'markdown',
        text: `**Question:**\n\n${event.question}`,
      },
    ];

    if (event.suggestions.length > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ' ' }],
      });

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Suggestions:*' },
      });

      event.suggestions.forEach(
        (suggestion: string | { answer: string }, index: number) => {
          const suggestionText =
            typeof suggestion === 'string' ? suggestion : suggestion.answer;

          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: convertMarkdownToSlack(suggestionText),
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Select', emoji: true },
              value: suggestionText,
              action_id: `followup_answer_${index}`,
            },
          });
        },
      );
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_You can also @-mention me with a custom response._',
        },
      ],
    });

    const slack = await getSlackNotifier();

    const followupMessageTs = await slack.postMessage({
      blocks,
      ...getSlackConversation(taskRun),
    });
    await recordOutboundSlackMessageForTaskRun({
      taskRun,
      messageTs: followupMessageTs,
      text: event.question,
      source: 'followup_question',
      metadata:
        event.suggestions.length > 0
          ? { suggestionCount: event.suggestions.length }
          : undefined,
    });
  } catch (error) {
    reportSlackCallbackError(
      error,
      'slackMentionCallbacks.handleFollowup.postMessage',
      taskRun.id,
    );
    console.error(
      `Failed to post followup question to Slack: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let slack: SlackNotifier | undefined = undefined;

async function getSlackNotifier() {
  if (!slack) {
    const slackInstallation = await sdk.slackInstallations.findFirst();

    if (!slackInstallation) {
      throw new Error('Slack installation not found.');
    }

    slack = new SlackNotifier(slackInstallation.botAccessToken);
  }

  return slack;
}

async function removeSlackAckReaction(
  taskRun: TaskRun,
  slack: SlackNotifier,
): Promise<void> {
  const originMessageTs = getSlackOriginMessageTs(taskRun);

  if (!originMessageTs) {
    return;
  }

  const { channel } = getSlackConversation(taskRun);
  const ackEmoji = getStoredSlackAckEmoji(taskRun);

  const reaction = {
    channel,
    timestamp: originMessageTs,
    name: ackEmoji,
  };

  let removed = await slack.removeReaction(reaction);

  if (removed) {
    return;
  }

  console.warn(
    `[slackMentionCallbacks#onStart] Slack reaction cleanup failed for task run ${taskRun.id}; retrying once (emoji=${ackEmoji}, channel=${channel}, timestamp=${originMessageTs})`,
  );

  removed = await slack.removeReaction(reaction);

  if (!removed) {
    console.warn(
      `[slackMentionCallbacks#onStart] Slack reaction cleanup failed after retry for task run ${taskRun.id} (emoji=${ackEmoji}, channel=${channel}, timestamp=${originMessageTs})`,
    );
  }
}

function getSlackConversation(taskRun: TaskRun) {
  // For SlackAppMention jobs, channel and thread_ts are in the payload.
  if (taskRun.payloadKind === TaskPayloadKind.SlackAppMention) {
    const { channel, thread_ts } = taskRun.payload as TaskPayload<
      typeof TaskPayloadKind.SlackAppMention
    >;

    if (!thread_ts) {
      throw new Error('Thread TS not found.');
    }

    return { channel, thread_ts };
  }

  // For SnapshotResume runs with Slack metadata, channel and thread_ts are
  // copied onto the resume payload when the resume is enqueued.
  const resumeThreadTs =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume
      ? getSlackThreadTsFromTaskPayload(taskRun.payload)
      : null;

  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
    resumeThreadTs
  ) {
    const channel =
      getSlackChannelFromTaskPayload(taskRun.payload) ?? undefined;
    const thread_ts = resumeThreadTs;

    if (!channel) {
      throw new Error(
        'Slack channel not found in SnapshotResume payload. ' +
          'The source task run may not have included slackChannel in the resume payload.',
      );
    }

    return { channel, thread_ts };
  }

  throw new Error(
    `Task run ${taskRun.id} (payloadKind=${taskRun.payloadKind}) is not a Slack-originated job`,
  );
}

function getSlackOriginMessageTs(taskRun: TaskRun): string | null {
  if (taskRun.payloadKind === TaskPayloadKind.SlackAppMention) {
    const { ts } = taskRun.payload as TaskPayload<
      typeof TaskPayloadKind.SlackAppMention
    >;

    return ts;
  }

  if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
    const payload = taskRun.payload as { slackOriginMessageTs?: unknown };

    return typeof payload.slackOriginMessageTs === 'string'
      ? payload.slackOriginMessageTs
      : null;
  }

  return null;
}

function getStoredSlackAckEmoji(taskRun: TaskRun): string {
  return getSlackPayloadEmoji(taskRun, 'ackEmoji') ?? DEFAULT_SLACK_ACK_EMOJI;
}

function getSlackPayloadEmoji(
  taskRun: TaskRun,
  key: 'ackEmoji',
): string | null {
  const payload =
    taskRun.payload && typeof taskRun.payload === 'object'
      ? (taskRun.payload as Record<string, unknown>)
      : null;
  const emoji = payload?.[key];

  return typeof emoji === 'string' && emoji.trim() ? emoji.trim() : null;
}
