import { PRODUCT_NAME, type SlackBlock } from '@roomote/types';
import type { SlackMcpSetupRequirement } from '@roomote/cloud-agents/server';

import type { SlackNotifier } from './slack-notifier';

export type SlackMcpSetupSuggestion = Pick<
  SlackMcpSetupRequirement,
  'serviceId' | 'serviceName' | 'settingsUrl' | 'copyVariant'
>;

export function buildSlackMcpSetupSuggestionText(
  suggestion: SlackMcpSetupSuggestion,
): string {
  const { serviceName, settingsUrl, copyVariant } = suggestion;
  const action =
    copyVariant === 'deployment_disabled_non_admin'
      ? `ask a ${PRODUCT_NAME} admin to enable the ${serviceName} integration`
      : copyVariant === 'deployment_auth_required_non_admin'
        ? `ask a ${PRODUCT_NAME} admin to finish connecting ${serviceName}`
        : copyVariant === 'deployment_disabled_admin'
          ? `<${settingsUrl}|enable the ${serviceName} integration>`
          : copyVariant === 'deployment_auth_required_admin'
            ? `<${settingsUrl}|finish connecting ${serviceName}>`
            : `<${settingsUrl}|link your ${serviceName} account>`;

  return `That looks like a ${serviceName} link. I don't have ${serviceName} access yet — ${action} if you want me to be able to use it.`;
}

export function buildSlackMcpSetupSuggestionBlocks(
  suggestion: SlackMcpSetupSuggestion,
): SlackBlock[] {
  return [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: buildSlackMcpSetupSuggestionText(suggestion),
        },
      ],
    },
  ];
}

/**
 * Posts a small, non-blocking thread reply nudging the user to finish MCP
 * setup for a service their message linked to. Failures are swallowed so a
 * missed suggestion can never affect the task itself.
 */
export async function postSlackMcpSetupSuggestion({
  slack,
  channel,
  threadId,
  suggestion,
}: {
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  suggestion: SlackMcpSetupSuggestion;
}): Promise<string | undefined> {
  try {
    return await slack.postMessage({
      channel,
      thread_ts: threadId,
      text: buildSlackMcpSetupSuggestionText(suggestion),
      blocks: buildSlackMcpSetupSuggestionBlocks(suggestion),
    });
  } catch (error) {
    console.warn(
      `[SlackMcpSetupSuggestion] Failed to post ${suggestion.serviceId} setup suggestion in ${channel}:${threadId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
