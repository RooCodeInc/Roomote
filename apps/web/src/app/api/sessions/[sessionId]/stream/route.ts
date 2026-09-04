import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import {
  db,
  eq,
  fastAgentConversations,
  isSessionConversationResponding,
  sessions as unifiedSessions,
} from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';
import {
  findAccessibleFastSession,
  getFastSessionMessagesSince,
  getFastSessionDisplayTitle,
} from '@/lib/server/fast-sessions';
import { subscribeFastSessionReplyStream } from '@/lib/server/fast-session-reply-stream';

export const runtime = 'nodejs';

const STREAM_MAX_MS = 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;
/** Overlap the initial cursor so rows written while the page was loading are
 * not missed; clients merge by eventId, so replays are harmless. */
const INITIAL_CURSOR_OVERLAP_MS = 60_000;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await authorizeUserToken(request);

  if (!authResult.success) {
    return NextResponse.json(
      { error: 'Unauthorized request' },
      { status: 401 },
    );
  }

  const { sessionId } = await props.params;
  const parsedSessionId = z.string().uuid().safeParse(sessionId);
  if (!parsedSessionId.success) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const session = await findAccessibleFastSession(
    authResult,
    parsedSessionId.data,
  );
  if (!session) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const sinceParam = z.coerce
    .number()
    .int()
    .nonnegative()
    .safeParse(request.nextUrl.searchParams.get('since') ?? undefined);
  let cursor = sinceParam.success
    ? sinceParam.data
    : Date.now() - INITIAL_CURSOR_OVERLAP_MS;
  let lastTitle = session.title;
  let lastConversationResponding: boolean | null | undefined;

  return createResponse(request, async (sseSession) => {
    const startTime = Date.now();
    // A reply streams in as assistant text chunks while the model writes
    // it; the persisted row later arrives through the poll under the same
    // eventId and replaces the live text.
    const replyStream = await subscribeFastSessionReplyStream(
      session.id,
      (event) => {
        if (!sseSession.isConnected) return;
        try {
          void sseSession.push({ event }, 'chunk');
        } catch {
          // The poll loop notices the disconnect.
        }
      },
    );

    try {
      while (startTime + STREAM_MAX_MS > Date.now()) {
        if (!sseSession.isConnected) {
          break;
        }

        try {
          const { messages, cursor: nextCursor } =
            await getFastSessionMessagesSince(session.id, cursor);
          cursor = nextCursor;

          const [conversation] = await db
            .select({
              title: fastAgentConversations.title,
              unifiedSessionId: unifiedSessions.id,
              respondingUntil: unifiedSessions.respondingUntil,
            })
            .from(fastAgentConversations)
            .leftJoin(
              unifiedSessions,
              eq(unifiedSessions.fastConversationId, fastAgentConversations.id),
            )
            .where(eq(fastAgentConversations.id, session.id))
            .limit(1);
          const title = await getFastSessionDisplayTitle(
            session.id,
            conversation?.title ?? null,
          );
          const conversationResponding = conversation?.unifiedSessionId
            ? isSessionConversationResponding({
                respondingUntil: conversation.respondingUntil,
              })
            : null;
          if (messages.length > 0) {
            await sseSession.push(
              { messages, conversationResponding },
              'messages',
            );
          }
          const sessionUpdate: {
            title?: string;
            conversationResponding?: boolean | null;
          } = {};
          if (title && title !== lastTitle) {
            lastTitle = title;
            sessionUpdate.title = title;
          }
          if (conversationResponding !== lastConversationResponding) {
            lastConversationResponding = conversationResponding;
            sessionUpdate.conversationResponding = conversationResponding;
          }
          if (Object.keys(sessionUpdate).length > 0) {
            await sseSession.push(sessionUpdate, 'session');
          }
        } catch {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } finally {
      await replyStream.close();
    }

    if (sseSession.isConnected) {
      try {
        await sseSession.push(null, 'disconnect');
      } catch {
        // Client already disconnected, ignore.
      }
    }
  });
}
