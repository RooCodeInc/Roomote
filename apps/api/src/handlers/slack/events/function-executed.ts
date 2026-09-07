import { getRedis } from '@roomote/redis';
import { Env } from '@roomote/env';
import { getOrCreateFastAgentSession } from '@roomote/cloud-agents/server';
import { formatErrorForLog, type TaskInitiator } from '@roomote/types';
import {
  and,
  db,
  eq,
  getSessionForFastConversation,
  slackUserMappings,
} from '@roomote/db/server';
import {
  resolveSlackReactionNames,
  type SlackFunctionExecutedEvent,
  SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';
import {
  SLACK_WORKFLOW_CHANNEL_INPUT_KEYS,
  SLACK_WORKFLOW_COMPLETION_PREFIX,
  SLACK_WORKFLOW_COMPLETION_TTL_SECONDS,
  SLACK_WORKFLOW_PROMPT_AUTHOR_INPUT_KEYS,
  SLACK_WORKFLOW_PROMPT_INPUT_KEYS,
  SLACK_WORKFLOW_THREAD_INPUT_KEYS,
  START_SLACK_TASK_CALLBACK_ID,
} from '../constants.js';
import type { SlackWebhookContext } from '../context.js';
import {
  getSlackWorkflowInputString,
  isUnknownRecord,
} from '../helpers/event-normalization.js';
import { getSlackAutomationLaunchIdentity } from '../helpers/launch-identity.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import { startFastAgentResponse } from './message-entry.js';

function getSlackWorkflowCompletionKey(functionExecutionId: string): string {
  return `${SLACK_WORKFLOW_COMPLETION_PREFIX}${functionExecutionId}`;
}

async function getStoredSlackWorkflowSuccessCompletion(
  functionExecutionId: string,
): Promise<{ outputs: Record<string, unknown> } | null> {
  const raw = await getRedis().get(
    getSlackWorkflowCompletionKey(functionExecutionId),
  );

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (
      !isUnknownRecord(parsed) ||
      parsed.status !== 'success' ||
      !isUnknownRecord(parsed.outputs)
    ) {
      return null;
    }

    return { outputs: parsed.outputs };
  } catch (error) {
    console.warn(
      `[SlackWorkflow] Failed to parse stored workflow completion for ${functionExecutionId}: ${formatErrorForLog(error)}`,
    );
    return null;
  }
}

async function storeSlackWorkflowSuccessCompletion({
  functionExecutionId,
  outputs,
}: {
  functionExecutionId: string;
  outputs: Record<string, unknown>;
}): Promise<void> {
  await getRedis().set(
    getSlackWorkflowCompletionKey(functionExecutionId),
    JSON.stringify({ status: 'success', outputs }),
    'EX',
    SLACK_WORKFLOW_COMPLETION_TTL_SECONDS,
  );
}

async function completeSlackWorkflowFunctionError({
  primarySlack,
  fallbackSlack,
  functionExecutionId,
  error,
}: {
  primarySlack: SlackNotifier;
  fallbackSlack?: SlackNotifier;
  functionExecutionId: string;
  error: string;
}): Promise<boolean> {
  if (
    await primarySlack.completeFunctionError({
      functionExecutionId,
      error,
    })
  ) {
    return true;
  }

  if (!fallbackSlack) {
    return false;
  }

  apiLogger.warn(
    `[SlackWorkflow] Retrying function failure completion with installed bot token for ${functionExecutionId}`,
  );

  return await fallbackSlack.completeFunctionError({
    functionExecutionId,
    error,
  });
}

async function completeSlackWorkflowFunctionSuccess({
  primarySlack,
  fallbackSlack,
  functionExecutionId,
  outputs,
}: {
  primarySlack: SlackNotifier;
  fallbackSlack?: SlackNotifier;
  functionExecutionId: string;
  outputs?: Record<string, unknown>;
}): Promise<boolean> {
  if (
    await primarySlack.completeFunctionSuccess({
      functionExecutionId,
      outputs,
    })
  ) {
    return true;
  }

  if (!fallbackSlack) {
    return false;
  }

  apiLogger.warn(
    `[SlackWorkflow] Retrying function success completion with installed bot token for ${functionExecutionId}`,
  );

  return await fallbackSlack.completeFunctionSuccess({
    functionExecutionId,
    outputs,
  });
}

export async function processSlackWorkflowFunctionExecuted(params: {
  functionEvent: SlackFunctionExecutedEvent;
  context: SlackWebhookContext;
}): Promise<void> {
  const { functionEvent, context } = params;
  const workflowSlack = new SlackNotifier(functionEvent.bot_access_token);
  const functionExecutionId = functionEvent.function_execution_id;

  const completeError = async (error: string): Promise<boolean> => {
    const completed = await completeSlackWorkflowFunctionError({
      primarySlack: workflowSlack,
      fallbackSlack: context.slack,
      functionExecutionId,
      error,
    });

    if (!completed) {
      console.error(
        `[SlackWorkflow] Failed to report workflow function failure for ${functionExecutionId}`,
      );
    }

    return completed;
  };

  const completeSuccess = async (outputs?: Record<string, unknown>) => {
    const completed = await completeSlackWorkflowFunctionSuccess({
      primarySlack: workflowSlack,
      fallbackSlack: context.slack,
      functionExecutionId,
      outputs,
    });

    if (!completed) {
      console.error(
        `[SlackWorkflow] Failed to report workflow function success for ${functionExecutionId}`,
      );
    }
  };

  try {
    if (functionEvent.function.callback_id !== START_SLACK_TASK_CALLBACK_ID) {
      await completeError(
        `Unsupported Slack workflow callback: ${functionEvent.function.callback_id}`,
      );
      return;
    }

    const storedCompletion =
      await getStoredSlackWorkflowSuccessCompletion(functionExecutionId);

    if (storedCompletion) {
      await completeSuccess(storedCompletion.outputs);
      return;
    }

    const prompt = getSlackWorkflowInputString(functionEvent.inputs, [
      ...SLACK_WORKFLOW_PROMPT_INPUT_KEYS,
    ]);
    const channelId = getSlackWorkflowInputString(functionEvent.inputs, [
      ...SLACK_WORKFLOW_CHANNEL_INPUT_KEYS,
    ]);
    const threadTs = getSlackWorkflowInputString(functionEvent.inputs, [
      ...SLACK_WORKFLOW_THREAD_INPUT_KEYS,
    ]);
    const promptAuthorSlackUserId = getSlackWorkflowInputString(
      functionEvent.inputs,
      [...SLACK_WORKFLOW_PROMPT_AUTHOR_INPUT_KEYS],
    );

    if (!prompt || !channelId) {
      await completeError(
        'Missing required Slack workflow inputs. Expected prompt and channel_id.',
      );
      return;
    }

    const launchIdentity = await getSlackAutomationLaunchIdentity({
      slackInstallation: context.slackInstallation,
      teamId: context.teamId,
      slackUserId: promptAuthorSlackUserId,
    });

    // When the workflow step carries a human author, that human is the
    // initiator (matched to a Roomote user when a mapping exists); otherwise
    // the launch is automation-initiated.
    const promptAuthorMapping = promptAuthorSlackUserId
      ? await db.query.slackUserMappings.findFirst({
          where: and(
            eq(slackUserMappings.slackUserId, promptAuthorSlackUserId),
            eq(slackUserMappings.slackTeamId, context.teamId),
          ),
          columns: { userId: true },
        })
      : null;
    const initiator: TaskInitiator = promptAuthorSlackUserId
      ? {
          kind: 'user',
          externalId: promptAuthorSlackUserId,
          ...(promptAuthorMapping?.userId
            ? { matchedUserId: promptAuthorMapping.userId }
            : {}),
        }
      : { kind: 'automation', key: 'slack_workflow' };

    // A workflow step without a thread gets one: the prompt is posted as a
    // root message so the Fast conversation has a thread to live in.
    let threadRootTs = threadTs?.trim() || undefined;
    if (!threadRootTs) {
      const authorLabel = promptAuthorSlackUserId
        ? `<@${promptAuthorSlackUserId}>`
        : 'a Slack workflow';
      threadRootTs = await context.slack.postMessage({
        channel: channelId,
        text: `Workflow request from ${authorLabel}:\n\n${prompt}`,
        blocks: [
          {
            type: 'markdown',
            text: `Workflow request from ${authorLabel}:\n\n${prompt}`,
          },
        ],
      });
      if (!threadRootTs) {
        await completeError(
          'Roomote could not post the workflow request into the channel.',
        );
        return;
      }
    }

    // The step enters a Fast Session the way a mention would: under the
    // prompt author when one is linked, otherwise under the automation
    // launch identity, with the workflow initiator kept for delegated tasks.
    const launchUserMapping = promptAuthorSlackUserId
      ? (
          await lookupSlackUserMapping({
            slackUserId: promptAuthorSlackUserId,
            teamId: context.teamId,
          })
        ).activeMapping
      : null;
    const fastUserId = launchUserMapping?.userId ?? launchIdentity.launchUserId;
    const fastSlackUserId = launchUserMapping
      ? launchUserMapping.slackUserId
      : launchIdentity.slackUserId;
    const { ackEmoji } = await resolveSlackReactionNames();
    const fastStart = await startFastAgentResponse({
      event: {
        type: 'app_mention',
        channel: channelId,
        user: fastSlackUserId,
        text: prompt,
        ts: threadRootTs,
        thread_ts: threadRootTs,
      },
      slackInstallation: context.slackInstallation,
      ...(launchUserMapping ? { userMapping: launchUserMapping } : {}),
      slack: context.slack,
      userId: fastUserId,
      teamId: context.teamId,
      directedAtRoomote: true,
      ...(initiator.kind === 'automation'
        ? { delegatedTaskInitiator: initiator }
        : {}),
      processingReactionName: ackEmoji,
      errorLogPrefix: `[SlackWorkflow] Fast response failed for ${functionExecutionId}:`,
    });

    if (!fastStart.accepted) {
      await completeError(
        `Roomote could not start a conversation for this workflow step: ${fastStart.reason}`,
      );
      return;
    }

    // The step's outputs point at the Session that now owns the request.
    const fastSession = await getOrCreateFastAgentSession({
      userId: fastUserId,
      conversation: {
        surface: 'slack',
        workspaceId: context.teamId,
        conversationId: threadRootTs,
        replyTarget: { channelId, threadId: threadRootTs },
      },
    });
    const session = await getSessionForFastConversation(db, fastSession.id);
    const sessionUrl = session ? `${Env.R_APP_URL}/sessions/${session.id}` : '';

    const outputs = {
      task_id: '',
      task_url: sessionUrl,
      session_id: session?.id ?? '',
      session_url: sessionUrl,
    };
    await storeSlackWorkflowSuccessCompletion({
      functionExecutionId,
      outputs,
    }).catch((error) => {
      console.warn(
        `[SlackWorkflow] Failed to store workflow success completion for ${functionExecutionId}: ${formatErrorForLog(error)}`,
      );
    });

    await completeSuccess(outputs);
  } catch (error) {
    console.error(
      `[SlackWorkflow] Failed to process function execution ${functionExecutionId}: ${formatErrorForLog(error)}`,
    );
    await completeError(
      'Roomote could not start this workflow task. Check Roomote logs for details.',
    );
  }
}
