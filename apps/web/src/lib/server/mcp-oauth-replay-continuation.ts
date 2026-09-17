import { and, db, eq, sessions } from '@roomote/db/server';
import { consumeMcpOauthReplay } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { logger } from '@/lib/server/logger';
import { replyToFastSessionCommand } from '@/trpc/commands/fast-sessions';

/**
 * Consume the replay token an agent-issued authorization link carried and
 * post a continuation into the Session that asked for the connection, so
 * the conversation resumes whether authorization succeeded or never
 * started. Returns whether a continuation was posted. The replay must name
 * the signed-in human, the connection, and the integration the caller is
 * acting on; anything else is silently ignored.
 */
export async function resumeFastSessionFromReplay(input: {
  replayToken: string;
  authResult: UserAuthSuccess;
  connectionId: string;
  mcpId: string;
  text: string;
  event: string;
}): Promise<boolean> {
  const replay = await consumeMcpOauthReplay(input.replayToken);
  if (
    !replay ||
    replay.userId !== input.authResult.userId ||
    replay.connectionId !== input.connectionId ||
    replay.mcpId !== input.mcpId ||
    !replay.sessionId
  ) {
    return false;
  }
  const ownerSession = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.id, replay.sessionId),
      eq(sessions.ownerKind, 'user'),
      eq(sessions.ownerUserId, input.authResult.userId),
    ),
    columns: { archivedAt: true, fastConversationId: true },
  });
  if (!ownerSession?.fastConversationId || ownerSession.archivedAt) {
    return false;
  }
  try {
    await replyToFastSessionCommand(input.authResult, {
      sessionId: ownerSession.fastConversationId,
      text: input.text,
    });
    return true;
  } catch (error) {
    logger.error(
      {
        event: input.event,
        connectionId: input.connectionId,
        integrationId: input.mcpId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'Failed to continue the Fast Session after custom MCP OAuth',
    );
    return false;
  }
}
