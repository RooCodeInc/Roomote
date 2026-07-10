import {
  db,
  slackInstallations,
  slackUserMappings,
  eq,
  and,
  resolveTelegramRuntimeCredentials,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  findTelegramPrimaryChatId,
  findTeamsPrimaryConversation,
} from '@roomote/sdk/server';

async function getActiveSlackInstallation(
  executor: DatabaseOrTransaction = db,
) {
  const [installation] = await executor
    .select({
      botAccessToken: slackInstallations.botAccessToken,
      teamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  return installation ?? null;
}

async function getSlackUserMappingForTeam(
  input: {
    userId: string;
    teamId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const [mapping] = await executor
    .select({
      slackUserId: slackUserMappings.slackUserId,
    })
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.userId, input.userId),
        eq(slackUserMappings.slackTeamId, input.teamId),
      ),
    )
    .limit(1);

  return mapping ?? null;
}

export async function getSetupSlackAccessStatus(
  input: {
    userId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const installation = await getActiveSlackInstallation(executor);

  if (!installation) {
    return {
      hasSlackInstallation: false,
      hasSlackUserMapping: false,
    };
  }

  const mapping = await getSlackUserMappingForTeam(
    {
      userId: input.userId,
      teamId: installation.teamId,
    },
    executor,
  );

  return {
    hasSlackInstallation: true,
    hasSlackUserMapping: mapping !== null,
  };
}

/**
 * Resolves the Slack DM target for the setup onboarding handoff. Returns null
 * when the deployment has no active Slack installation or the admin has no
 * linked Slack account, so setup can fall back to a web-only onboarding task.
 */
export async function resolveSetupSlackHandoffTarget(
  input: {
    userId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  const installation = await getActiveSlackInstallation(executor);

  if (!installation) {
    return null;
  }

  const mapping = await getSlackUserMappingForTeam(
    {
      userId: input.userId,
      teamId: installation.teamId,
    },
    executor,
  );

  if (!mapping) {
    return null;
  }

  return {
    botAccessToken: installation.botAccessToken,
    slackTeamId: installation.teamId,
    slackUserId: mapping.slackUserId,
  };
}

type SetupChatFallbackHandoffTarget =
  | { provider: 'telegram'; chatId: string; botToken: string }
  | {
      provider: 'teams';
      conversationId: string;
      serviceUrl: string;
      teams: TeamsCommunicationProvider;
    };

/**
 * Resolves the non-Slack chat destination for the setup onboarding kickoff,
 * matching the proactive-messaging fallback ordering (Slack > Telegram >
 * Teams). Returns null when no chat surface is available, so setup falls
 * back to a web-only onboarding task. Teams is only selected when both a
 * captured primary conversation and resolvable bot credentials exist, so a
 * half-configured Teams deployment never blocks onboarding.
 */
export async function resolveSetupChatFallbackHandoffTarget(): Promise<SetupChatFallbackHandoffTarget | null> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (botToken) {
    const chatId = await findTelegramPrimaryChatId();

    if (chatId) {
      return { provider: 'telegram', chatId, botToken };
    }
  }

  const conversation = await findTeamsPrimaryConversation();

  if (conversation) {
    const teams =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (teams) {
      return {
        provider: 'teams',
        conversationId: conversation.conversationId,
        serviceUrl: conversation.serviceUrl,
        teams,
      };
    }

    console.warn(
      '[setup-new] Skipping the Teams setup kickoff because Teams bot credentials could not be resolved; onboarding continues as a web-only task.',
    );
  }

  return null;
}
