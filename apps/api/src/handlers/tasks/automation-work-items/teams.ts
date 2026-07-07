import { db, eq, slackInstallations } from '@roomote/db/server';

import {
  findTeamsPrimaryConversation,
  postTeamsAutomationMessageBestEffort,
} from '../../teams/automation-messaging.js';
import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { PersistedAutomationWorkItem } from './types.js';

/**
 * Teams destination for automation execution output when the deployment has
 * neither a Slack installation nor a Telegram destination: the primary
 * Teams conversation. Callers try Slack, then Telegram, then this.
 */
export async function resolveAutomationTeamsTarget(): Promise<{
  provider: 'teams';
  conversationId: string;
  serviceUrl: string;
} | null> {
  // Match the other automation paths' gate: Slack-installed deployments
  // keep automation output on Slack even when a channel is temporarily
  // unresolvable, so summaries and execution closeouts never split across
  // surfaces.
  const [slackInstallation] = await db
    .select({ id: slackInstallations.id })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (slackInstallation) {
    return null;
  }

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
