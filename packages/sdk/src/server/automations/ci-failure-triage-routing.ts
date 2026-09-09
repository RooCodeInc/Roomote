import {
  findActiveSlackInstallationForChannel,
  getAutomationRuntime,
  db,
  eq,
  and,
  teamsInstallations,
  fastAgentConversations,
  type AutomationRuntime,
} from '@roomote/db/server';
import {
  getCiFailureTriageRules,
  isCiFailureTriageRepositoryAllowed,
  type CommunicationProvider,
} from '@roomote/types';

import {
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import { findDiscordDestinationByChannelId } from '../lib/discord-persistence';

/** Webhook adapters call this before fetching provider logs or pipeline details. */
export async function isCiFailureTriageRepositoryEnabled(
  repositoryId: string,
): Promise<boolean> {
  const runtime = await getAutomationRuntime('ci_failure_triage');
  return (
    runtime.enabled &&
    runtime.scheduleMode !== 'off' &&
    isCiFailureTriageRepositoryAllowed(runtime.settings, repositoryId)
  );
}

export async function resolveCiFailureTriageRepositoryDestination(params: {
  runtime: Pick<AutomationRuntime, 'settings' | 'destination' | 'targets'>;
  repositoryId: string;
  connectedProviders: readonly CommunicationProvider[];
  destination?: ResolvedAutomationDestination;
}): Promise<ResolvedAutomationDestination | null> {
  if (
    !isCiFailureTriageRepositoryAllowed(
      params.runtime.settings,
      params.repositoryId,
    )
  )
    return null;
  const rules = getCiFailureTriageRules(params.runtime.settings);
  const route = rules?.destinations.find(
    (entry) => entry.repositoryId === params.repositoryId,
  );
  // Explicit routing cannot be replaced by a Run now default.
  if (!route && params.destination) return params.destination;
  if (route && !params.connectedProviders.includes(route.target.provider))
    return null;
  if (route?.target.provider === 'slack') {
    const teamId = route.target.workspaceId;
    if (
      typeof teamId !== 'string' ||
      !teamId.trim() ||
      teamId !== teamId.trim()
    )
      return null;
    const installation = await findActiveSlackInstallationForChannel(
      route.target.externalRef,
      teamId,
    );
    return installation
      ? {
          provider: 'slack',
          channelId: route.target.externalRef,
          teamId: installation.teamId,
          source: 'automation_target',
        }
      : null;
  }
  if (route?.target.provider === 'discord') {
    const destination = await findDiscordDestinationByChannelId(
      route.target.externalRef,
    );
    return destination?.guildId === route.target.workspaceId
      ? {
          provider: 'discord',
          channelId: route.target.externalRef,
          source: 'automation_target',
        }
      : null;
  }
  if (route?.target.provider === 'teams') {
    const rows = await db.query.teamsInstallations.findMany({
      where: and(
        eq(teamsInstallations.conversationId, route.target.externalRef),
        eq(teamsInstallations.tenantId, route.target.workspaceId),
        eq(teamsInstallations.isActive, true),
      ),
    });
    if (rows.length !== 1 || !rows[0]!.serviceUrl) return null;
    return {
      provider: 'teams',
      channelId: route.target.externalRef,
      serviceUrl: rows[0]!.serviceUrl,
      source: 'automation_target',
    };
  }
  if (route?.target.provider === 'telegram') {
    const known = await db.query.fastAgentConversations.findFirst({
      where: and(
        eq(fastAgentConversations.surface, 'telegram'),
        eq(fastAgentConversations.workspaceId, route.target.workspaceId),
        eq(
          fastAgentConversations.currentReplyChannelId,
          route.target.externalRef,
        ),
        eq(fastAgentConversations.replyTargetVerified, true),
      ),
    });
    return known
      ? {
          provider: 'telegram',
          channelId: route.target.externalRef,
          source: 'automation_target',
        }
      : null;
  }
  return resolveAutomationRuntimeDestination({
    runtime: params.runtime,
    slackConnected: params.connectedProviders.includes('slack'),
  });
}
