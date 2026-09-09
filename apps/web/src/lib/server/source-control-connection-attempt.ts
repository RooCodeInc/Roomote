import {
  and,
  db,
  eq,
  gt,
  isNull,
  sourceControlConnectionRequests,
  sql,
  users,
  getSessionForFastConversation,
} from '@roomote/db/server';
import {
  getSourceControlConnectionRequest,
  getSourceControlSyncStartedAt,
  isSourceControlConnectionEnabled,
  reconcileSourceControlConnectionRequests,
} from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';
import { normalizeSourceControlOAuthReturnTarget } from './source-control-oauth-redirect';
import {
  signConnectionState,
  verifyConnectionState,
  type SourceControlConnectionState,
} from './source-control-connection-state';

async function assertLiveAdmin(auth: UserAuthSuccess) {
  const user = await db.query.users.findFirst({
    where: and(
      eq(users.id, auth.userId),
      eq(users.role, 'admin'),
      isNull(users.deletedAt),
    ),
    columns: { id: true },
  });
  if (!user) throw new Error('Forbidden.');
}

// A separate advisory lock serializes attempt replacement and callback completion
// without holding the conversation row lock while the SDK admits its event.
async function withAttemptLock<T>(
  requestId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!requestId) return run();
  return db.transaction(async (tx) => {
    // Fail rather than accumulating blocked transactions if a browser retries
    // while its previous callback is still synchronizing repositories.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`source-control-attempt:${requestId}`}))`,
    );
    return run();
  });
}

export async function beginConnectionAttempt(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlConnectionState['provider'];
    requestId?: string;
    returnTarget?: string | null;
    purpose?: SourceControlConnectionState['purpose'];
  },
) {
  await assertLiveAdmin(auth);
  return withAttemptLock(input.requestId, async () => {
    if (input.requestId && !(await isSourceControlConnectionEnabled()))
      throw new Error('Session connection requests are disabled.');
    let returnTarget =
      normalizeSourceControlOAuthReturnTarget(input.returnTarget) ??
      '/settings/source-control';
    let revision: number | undefined;
    if (input.requestId) {
      const request = await getSourceControlConnectionRequest({
        requestId: input.requestId,
        actorUserId: auth.userId,
      });
      if (
        !request ||
        request.status !== 'pending' ||
        (request.provider && request.provider !== input.provider)
      )
        throw new Error('Connection request is no longer available.');
      const session = await getSessionForFastConversation(
        db,
        request.conversationId,
      );
      if (!session || session.archivedAt)
        throw new Error('Session is no longer active.');
      const startedAt = await getSourceControlSyncStartedAt(input.provider);
      const [updated] = await db
        .update(sourceControlConnectionRequests)
        .set({
          revision: sql`${sourceControlConnectionRequests.revision} + 1`,
          syncAttempt: {
            provider: input.provider,
            startedAt,
            state: 'authorizing',
          },
          reason: 'sync_pending',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceControlConnectionRequests.id, request.id),
            eq(sourceControlConnectionRequests.status, 'pending'),
            eq(sourceControlConnectionRequests.revision, request.revision),
            gt(sourceControlConnectionRequests.expiresAt, new Date()),
          ),
        )
        .returning({ revision: sourceControlConnectionRequests.revision });
      if (!updated)
        throw new Error('Connection request changed. Please try again.');
      revision = updated.revision;
      returnTarget = request.url;
    }
    return signConnectionState({
      actorUserId: auth.userId,
      provider: input.provider,
      returnTarget,
      requestId: input.requestId,
      revision,
      purpose: input.purpose,
    });
  });
}

export async function completeConnectionAttempt<
  T extends { success: boolean; repositories?: { fullName: string }[] },
>(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlConnectionState['provider'];
    state: string;
    reconcile?: boolean;
  },
  synchronize: () => Promise<T>,
) {
  await assertLiveAdmin(auth);
  const binding = verifyConnectionState(
    input.state,
    auth.userId,
    input.provider,
  );
  return withAttemptLock(binding.requestId, async () => {
    if (binding.requestId && !(await isSourceControlConnectionEnabled()))
      throw new Error('Session connection requests are disabled.');
    verifyConnectionState(input.state, auth.userId, input.provider);
    await assertLiveAdmin(auth);
    let returnTarget =
      normalizeSourceControlOAuthReturnTarget(binding.returnTarget) ??
      '/settings/source-control';
    let attempt:
      | NonNullable<
          typeof sourceControlConnectionRequests.$inferSelect.syncAttempt
        >
      | undefined;
    if (binding.requestId) {
      const request = await getSourceControlConnectionRequest({
        requestId: binding.requestId,
        actorUserId: auth.userId,
      });
      if (
        !request ||
        request.status !== 'pending' ||
        request.revision !== binding.revision ||
        (request.provider && request.provider !== input.provider)
      )
        throw new Error(
          'Connection attempt was replaced or is no longer active.',
        );
      const session = await getSessionForFastConversation(
        db,
        request.conversationId,
      );
      if (!session || session.archivedAt)
        throw new Error('Session is no longer active.');
      returnTarget = request.url;
      attempt = {
        ...request.syncAttempt,
        provider: input.provider,
        startedAt:
          request.syncAttempt?.startedAt ??
          (await getSourceControlSyncStartedAt(input.provider)),
        state: 'syncing',
      };
      // Consume before exchanging the code. Denial/failure requires an explicit new attempt.
      const [claimed] = await db
        .update(sourceControlConnectionRequests)
        .set({
          revision: sql`${sourceControlConnectionRequests.revision} + 1`,
          syncAttempt: sql`jsonb_set(coalesce(${sourceControlConnectionRequests.syncAttempt}, ${JSON.stringify(attempt)}::jsonb), '{state}', '"syncing"'::jsonb)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceControlConnectionRequests.id, request.id),
            eq(sourceControlConnectionRequests.status, 'pending'),
            eq(sourceControlConnectionRequests.revision, binding.revision!),
            gt(sourceControlConnectionRequests.expiresAt, new Date()),
          ),
        )
        .returning({ id: sourceControlConnectionRequests.id });
      if (!claimed) throw new Error('Connection request changed.');
    }
    const startedAt = await getSourceControlSyncStartedAt(input.provider);
    let result: T;
    try {
      result = await synchronize();
    } catch (error) {
      if (attempt)
        await db
          .update(sourceControlConnectionRequests)
          .set({
            syncAttempt: {
              ...attempt,
              startedAt: await getSourceControlSyncStartedAt(input.provider),
              successfulSync: undefined,
              state: 'failed',
            },
            reason: 'sync_failed',
          })
          .where(
            and(
              eq(sourceControlConnectionRequests.id, binding.requestId!),
              eq(
                sourceControlConnectionRequests.revision,
                binding.revision! + 1,
              ),
              eq(sourceControlConnectionRequests.status, 'pending'),
            ),
          );
      throw error;
    }
    if (attempt)
      await db
        .update(sourceControlConnectionRequests)
        .set({
          syncAttempt: result.success
            ? sql`jsonb_set(${sourceControlConnectionRequests.syncAttempt}, '{state}', '"pending"'::jsonb)`
            : {
                ...attempt,
                startedAt: await getSourceControlSyncStartedAt(input.provider),
                successfulSync: undefined,
                state: 'failed',
              },
          reason: result.success ? 'sync_pending' : 'sync_failed',
        })
        .where(
          and(
            eq(sourceControlConnectionRequests.id, binding.requestId!),
            eq(sourceControlConnectionRequests.revision, binding.revision! + 1),
            eq(sourceControlConnectionRequests.status, 'pending'),
          ),
        );
    const current = binding.requestId
      ? await db.query.sourceControlConnectionRequests.findFirst({
          where: eq(sourceControlConnectionRequests.id, binding.requestId),
        })
      : undefined;
    const asyncProof =
      current?.revision === binding.revision! + 1 &&
      binding.purpose === 'github-install'
        ? current.syncAttempt?.successfulSync
        : undefined;
    if (result.success && (input.reconcile !== false || asyncProof)) {
      // Successful authorization alone is not proof that inventory was synchronized.
      const proof = result.repositories
        ? {
            startedAt,
            repositoryFullNames: result.repositories.map(
              (repository) => repository.fullName,
            ),
          }
        : asyncProof
          ? asyncProof
          : { startedAt, repositoryFullNames: [] };
      await reconcileSourceControlConnectionRequests(
        {
          provider: input.provider,
          requestId: binding.requestId,
          attemptRevision: binding.requestId
            ? binding.revision! + 1
            : undefined,
          completedByUserId: auth.userId,
        },
        { successfulSync: proof },
      );
    }
    return { result, returnTarget };
  });
}
