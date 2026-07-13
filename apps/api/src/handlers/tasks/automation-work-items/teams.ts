import {
  findTeamsPrimaryConversation,
  postTeamsAutomationMessageBestEffort,
} from '../../teams/automation-messaging.js';
import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { PersistedAutomationWorkItem } from './types.js';

/**
 * Resolves the Teams primary conversation. The caller applies provider
 * precedence before invoking this fallback.
 */
export async function resolveAutomationTeamsTarget(): Promise<{
  provider: 'teams';
  conversationId: string;
  serviceUrl: string;
} | null> {
  const conversation = await findTeamsPrimaryConversation();

  if (!conversation) {
    return null;
  }

  return {
    provider: 'teams',
    conversationId: conversation.conversationId,
    serviceUrl: conversation.serviceUrl,
  };
}

export async function postLateBoundWorkItemFailureToTeams(params: {
  conversationId: string;
  serviceUrl: string;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
  const text = [
    `**${buildSuggestionBadgePrefix({
      category: params.workItem.category,
      priority: params.workItem.priority,
    })}${params.workItem.title}**`,
    params.workItem.brief,
    '',
    `An automation queued this work item, but the execution task failed to launch: ${params.reason}`,
  ].join('\n');

  await postTeamsAutomationMessageBestEffort({
    conversationId: params.conversationId,
    serviceUrl: params.serviceUrl,
    text,
  });
}
