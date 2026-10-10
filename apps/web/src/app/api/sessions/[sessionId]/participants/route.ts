import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  and,
  db,
  eq,
  fastAgentMessages,
  inArray,
  sql,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';
import { authorize } from '@/lib/server/auth-context';
import { findReadableFastSession } from '@/lib/server/fast-sessions';
import { getUsersById } from '@/lib/server/users';

export async function GET(
  _request: Request,
  props: { params: Promise<{ sessionId: string }> },
) {
  const auth = await authorize();
  if (!auth.success)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sessionId } = await props.params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const session = await findReadableFastSession(auth, sessionId);
  if (!session || session.surface !== 'web') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  const rows = await db
    .selectDistinct({
      userId: sql<string>`${fastAgentMessages.metadata}->>'userId'`,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        eq(fastAgentMessages.role, 'user'),
        inArray(fastAgentMessages.eventType, [
          ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          ACP_ENVELOPE_EVENT_TYPES.PeerMessage,
          ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        ]),
        sql`${fastAgentMessages.metadata}->>'userId' is not null`,
      ),
    );
  const ids = [
    ...new Set([
      ...(session.userId ? [session.userId] : []),
      ...rows.map((row) => row.userId),
    ]),
  ];
  const participants = await getUsersById(ids);
  return NextResponse.json(Object.values(participants), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
