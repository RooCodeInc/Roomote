import { getRedis } from '@roomote/redis';
import { formatErrorForLog } from '@roomote/types';
import {
  type SlackFunctionExecutedEvent,
  SlackNotifier,
  startAutoRoutedSlackTask,
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
import { showManualPickerForAutoRouteFallback } from './auto-route-fallback.js';

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

    const result = await startAutoRoutedSlackTask({
      slackInstallation: context.slackInstallation,
      slack: context.slack,
      launchUserId: launchIdentity.launchUserId,
      slackUserId: launchIdentity.slackUserId,
      initiatingSlackUserId:
        launchIdentity.slackUserId === context.slackInstallation.botUserId
          ? undefined
          : launchIdentity.slackUserId,
      channel: channelId,
      prompt,
      threadTs,
    });

    if (result.status !== 'started') {
      if (
        result.status === 'not_started' &&
        result.code === 'routing_fallback'
      ) {
        const targetThreadTs = threadTs?.trim();
        const launchSlackUserId = launchIdentity.slackUserId?.trim();

        if (targetThreadTs && launchSlackUserId) {
          const showedManualPicker = await showManualPickerForAutoRouteFallback(
            {
              result,
              event: {
                type: 'function_executed',
                channel: channelId,
                user: launchSlackUserId,
                text: prompt,
                ts: targetThreadTs,
                thread_ts: targetThreadTs,
              },
              slackInstallation: context.slackInstallation,
              userMapping: { userId: launchIdentity.launchUserId },
              slack: context.slack,
            },
          );

          if (showedManualPicker) {
            await completeError(
              'Choose an environment in the Slack thread to continue.',
            );
            return;
          }
        }

        await completeError(
          'Slack workflow auto-routing needs a thread so Roomote can show the environment picker.',
        );
        return;
      }

      await completeError(
        result.status === 'not_started'
          ? result.message
          : 'Task was not started because Slack auto-routing did not launch a task.',
      );
      return;
    }

    const outputs = {
      task_id: result.taskId ?? '',
      task_url: result.taskUrl ?? '',
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
