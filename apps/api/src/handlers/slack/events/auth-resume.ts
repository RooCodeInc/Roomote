import {
  and,
  db,
  eq,
  gt,
  slackAuthTokens,
  slackInstallations,
} from '@roomote/db/server';
import {
  resolveSlackReactionNames,
  SlackNotifier,
  shouldResumeSlackAuthThread,
} from '@roomote/slack';

import { lookupSlackUserMapping } from '../helpers/user-mapping.js';
import { startFastAgentResponse } from './message-entry.js';

type ResumePendingSlackAuthResult =
  | { success: true; status: 'resumed' | 'not_resumable' }
  | {
      success: false;
      error:
        | 'invalid_or_expired_auth_token'
        | 'account_link_required'
        | 'slack_installation_not_found'
        | 'fast_session_not_accepted';
    };

export async function resumePendingSlackAuthRequest(
  stateToken: string,
): Promise<ResumePendingSlackAuthResult> {
  const authToken = await db.query.slackAuthTokens.findFirst({
    where: and(
      eq(slackAuthTokens.token, stateToken),
      gt(slackAuthTokens.expiresAt, new Date()),
    ),
  });

  if (!authToken) {
    return { success: false, error: 'invalid_or_expired_auth_token' };
  }

  const { activeMapping } = await lookupSlackUserMapping({
    slackUserId: authToken.slackUserId,
    teamId: authToken.slackTeamId,
  });

  if (!activeMapping) {
    return { success: false, error: 'account_link_required' };
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.teamId, authToken.slackTeamId),
  });

  if (!slackInstallation) {
    return { success: false, error: 'slack_installation_not_found' };
  }

  if (!shouldResumeSlackAuthThread(authToken.originalText)) {
    return { success: true, status: 'not_resumable' };
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken, {
    botUserId: slackInstallation.botUserId,
    botName: slackInstallation.botName,
    appName: slackInstallation.appName,
  });

  const messageTs = authToken.messageTs ?? authToken.threadTs;
  const { ackEmoji } = await resolveSlackReactionNames();
  const fastStart = await startFastAgentResponse({
    event: {
      type: 'app_mention',
      channel: authToken.channel,
      user: authToken.slackUserId,
      text: authToken.originalText,
      ts: messageTs,
      ...(messageTs !== authToken.threadTs
        ? { thread_ts: authToken.threadTs }
        : {}),
    },
    slackInstallation,
    userMapping: activeMapping,
    slack,
    userId: activeMapping.userId,
    teamId: authToken.slackTeamId,
    continuation: true,
    directedAtRoomote: true,
    processingReactionName: ackEmoji,
    errorLogPrefix: `Failed to resume pending Slack request in thread ${authToken.threadTs}:`,
  });

  if (!fastStart.accepted) {
    return { success: false, error: 'fast_session_not_accepted' };
  }

  let claimedAuthToken: typeof authToken | undefined;
  try {
    [claimedAuthToken] = await db
      .delete(slackAuthTokens)
      .where(
        and(
          eq(slackAuthTokens.token, stateToken),
          gt(slackAuthTokens.expiresAt, new Date()),
        ),
      )
      .returning();
  } catch (error) {
    await fastStart.abort().catch(() => undefined);
    throw error;
  }

  if (!claimedAuthToken) {
    await fastStart.abort().catch(() => undefined);
    return { success: false, error: 'invalid_or_expired_auth_token' };
  }

  return { success: true, status: 'resumed' };
}
