import { TRPCError } from '@trpc/server';
import {
  cancelSessionWakeupForConversation,
  listSessionWakeupsForConversation,
} from '@roomote/cloud-agents/server';

import { findAccessibleFastSession } from '@/lib/server/fast-sessions';
import {
  findAccessibleSession,
  findAccessibleSessionByFastConversationId,
} from '@/lib/server/sessions';
import type { UserAuthSuccess } from '@/types';

async function resolveWakeupSession(auth: UserAuthSuccess, sessionId: string) {
  const session =
    (await findAccessibleSession(auth, sessionId)) ??
    (await findAccessibleSessionByFastConversationId(auth, sessionId));
  if (session) {
    return {
      conversationId: session.fastConversationId,
      canCancel: auth.isAdmin || session.ownerUserId === auth.userId,
    };
  }

  // Older Fast conversations may not have a canonical Session row yet.
  const fast = await findAccessibleFastSession(auth, sessionId);
  if (!fast) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  return {
    conversationId: fast.id,
    canCancel: auth.isAdmin || fast.userId === auth.userId,
  };
}

export async function getSessionWakeupsCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const session = await resolveWakeupSession(auth, sessionId);
  const wakeups = session.conversationId
    ? await listSessionWakeupsForConversation(session.conversationId, {
        includeTerminal: false,
      })
    : [];
  return {
    wakeups,
    now: new Date().toISOString(),
    canCancel: session.canCancel,
  };
}

export async function cancelSessionWakeupCommand(
  auth: UserAuthSuccess,
  input: { sessionId: string; wakeupId: string },
) {
  const session = await resolveWakeupSession(auth, input.sessionId);
  if (!session.canCancel) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the Session owner or an admin can cancel wakeups',
    });
  }
  if (!session.conversationId) return { outcome: 'not_found' as const };
  return cancelSessionWakeupForConversation(
    session.conversationId,
    input.wakeupId,
  );
}
