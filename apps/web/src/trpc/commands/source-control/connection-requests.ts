import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  and,
  db,
  desc,
  eq,
  isNull,
  sourceControlConnectionRequests,
  users,
} from '@roomote/db/server';
import {
  cancelSourceControlConnectionRequest,
  getSourceControlConnectionRequest,
  isSourceControlConnectionEnabled,
  reconcileSourceControlConnectionRequests,
} from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';
import { findAccessibleSession } from '@/lib/server/sessions';

export const connectionRequestInput = z.object({
  sessionId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
});

export async function connectionRequestCommand(
  auth: UserAuthSuccess,
  input: z.infer<typeof connectionRequestInput>,
  action: 'view' | 'check' | 'cancel' = 'view',
) {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
  });
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const session = await findAccessibleSession(auth, input.sessionId);
  if (!session?.fastConversationId) return null;
  const latest = input.requestId
    ? { id: input.requestId }
    : await db.query.sourceControlConnectionRequests.findFirst({
        where: eq(
          sourceControlConnectionRequests.conversationId,
          session.fastConversationId,
        ),
        orderBy: desc(sourceControlConnectionRequests.createdAt),
        columns: { id: true },
      });
  if (!latest) return null;
  const context = {
    requestId: latest.id,
    conversationId: session.fastConversationId,
    actorUserId: user.id,
  };
  let request = await getSourceControlConnectionRequest(context);
  if (!request) return null;
  const canCancel = user.role === 'admin' || request.actorUserId === user.id;
  if (action !== 'view' && !canCancel)
    throw new TRPCError({ code: 'FORBIDDEN' });
  if (action === 'cancel')
    request = await cancelSourceControlConnectionRequest(context);
  const enabled = await isSourceControlConnectionEnabled();
  if (action === 'check') {
    if (!enabled)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Session connection requests are disabled.',
      });
    await reconcileSourceControlConnectionRequests({
      requestId: context.requestId,
      conversationId: session.fastConversationId,
    });
    request = await getSourceControlConnectionRequest(context);
  }
  if (!request) return null;
  // Deliberately project only display fields; authorization state never enters the transcript.
  return {
    enabled,
    id: request.id,
    url: request.url,
    status: request.status,
    reason: request.reason,
    provider: request.provider,
    repositoryFullName: request.repositoryFullName,
    environmentId: request.environmentId,
    expiresAt: request.expiresAt,
    canCancel:
      canCancel &&
      !request.executionStartedAt &&
      ['pending', 'ready'].includes(request.status),
    canCheck: enabled && canCancel && request.status === 'pending',
    canConnect:
      enabled &&
      user.role === 'admin' &&
      request.status === 'pending' &&
      !session.archivedAt,
  };
}
