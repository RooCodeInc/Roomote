import { TRPCError } from '@trpc/server';
import { upsertFastAgentMessage } from '@roomote/cloud-agents/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { findAccessibleFastSession } from '@/lib/server/fast-sessions';

/** Deliberately separate from reply admission: no turn, queue, or wake path. */
export async function sendSessionPeerMessageCommand(
  auth: UserAuthSuccess,
  input: { sessionId: string; clientMessageId: string; text: string },
) {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session || session.surface !== 'web') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  const text = input.text.trim();
  if (!text || text.length > 20_000) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid message' });
  }
  // Include the authenticated sender in the key: one viewer cannot collide
  // with another viewer's request ID. Insert-only makes concurrent retries
  // immutable, and uses the existing conversation transaction/unique index.
  const eventId = `peer:${auth.userId}:${input.clientMessageId}`;
  await upsertFastAgentMessage({
    sessionId: session.id,
    insertOnly: true,
    message: {
      eventId,
      turnId: eventId,
      turnSeq: 0,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.PeerMessage,
      role: 'user',
      contentBlocks: [{ type: 'text', text }],
      metadata: {
        visibleInTranscript: true,
        userId: auth.userId,
        clientMessageId: input.clientMessageId,
      },
      payload: {},
      source: 'web',
    },
  });
  return { success: true as const, eventId };
}
