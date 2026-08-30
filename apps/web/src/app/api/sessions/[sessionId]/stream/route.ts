import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import { db, eq, fastAgentConversations } from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';
import {
  findAccessibleFastSession,
  getFastSessionMessagesSince,
  getFastSessionDisplayTitle,
} from '@/lib/server/fast-sessions';

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

  return createResponse(request, async (sseSession) => {
    const startTime = Date.now();

    while (startTime + STREAM_MAX_MS > Date.now()) {
      if (!sseSession.isConnected) {
        break;
      }

      try {
        const { messages, cursor: nextCursor } =
          await getFastSessionMessagesSince(session.id, cursor);
        cursor = nextCursor;
        if (messages.length > 0) {
          await sseSession.push({ messages }, 'messages');
        }

        const conversation = await db.query.fastAgentConversations.findFirst({
          where: eq(fastAgentConversations.id, session.id),
          columns: { title: true },
        });
        const title = await getFastSessionDisplayTitle(
          session.id,
          conversation?.title ?? null,
        );
        if (title && title !== lastTitle) {
          lastTitle = title;
          await sseSession.push({ title }, 'session');
        }
      } catch {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
