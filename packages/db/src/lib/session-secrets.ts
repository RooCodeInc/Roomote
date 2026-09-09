import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type {
  SessionSecretCreate,
  SessionSecretPrepare,
  SessionSecretPendingMetadata,
  SessionSecretMetadata,
} from '@roomote/types';

import { db } from '../db';
import {
  sessionSecretApprovals,
  sessionSecretAudit,
  sessionSecrets,
  sessions,
  users,
  sessionTasks,
  taskRuns,
} from '../schema';
import { decrypt, encrypt } from './encryption';

/** Trusted server context only. Never deserialize this from tool arguments. */
export interface SessionSecretContext {
  sessionId: string;
  userId: string | null | undefined;
  runId?: number;
  fastConversationId?: string;
}

/** Resolve only signed server context. A caller-supplied Session ID is not authority. */
export async function resolveSessionSecretContext(
  auth:
    | {
        tokenType: 'session-broker';
        userId: string;
        fastConversationId: string;
      }
    | { tokenType: 'run'; runId: number },
): Promise<SessionSecretContext> {
  const [row] =
    auth.tokenType === 'run'
      ? await db
          .select({ sessionId: sessions.id, userId: taskRuns.actingUserId })
          .from(taskRuns)
          .innerJoin(sessionTasks, eq(sessionTasks.taskId, taskRuns.taskId))
          .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
          .innerJoin(users, eq(users.id, taskRuns.actingUserId))
          .where(
            and(
              eq(taskRuns.id, auth.runId),
              eq(sessions.ownerKind, 'user'),
              eq(sessions.ownerUserId, taskRuns.actingUserId),
              isNull(users.deletedAt),
              isNull(sessions.archivedAt),
            ),
          )
      : await db
          .select({ sessionId: sessions.id, userId: users.id })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.ownerUserId))
          .where(
            and(
              eq(sessions.fastConversationId, auth.fastConversationId),
              eq(sessions.ownerKind, 'user'),
              eq(users.id, auth.userId),
              isNull(users.deletedAt),
              isNull(sessions.archivedAt),
            ),
          );
  if (!row?.userId) throw new Error('Secret unavailable');
  return {
    ...row,
    ...(auth.tokenType === 'run'
      ? { runId: auth.runId }
      : { fastConversationId: auth.fastConversationId }),
  };
}

const metadataColumns = {
  secretRef: sessionSecrets.id,
  label: sessionSecrets.label,
  origin: sessionSecrets.origin,
  headerName: sessionSecrets.headerName,
  headerPrefix: sessionSecrets.headerPrefix,
  expiresAt: sessionSecrets.expiresAt,
  revokedAt: sessionSecrets.revokedAt,
  createdAt: sessionSecrets.createdAt,
};

function metadata(
  row:
    | typeof sessionSecrets.$inferSelect
    | {
        secretRef: string;
        label: string;
        origin: string;
        headerName: SessionSecretPrepare['headerName'];
        headerPrefix: SessionSecretPrepare['headerPrefix'];
        expiresAt: Date;
        revokedAt: Date | null;
        createdAt: Date;
      },
): SessionSecretMetadata {
  return {
    secretRef: 'secretRef' in row ? row.secretRef : row.id,
    label: row.label,
    origin: row.origin,
    headerName: row.headerName,
    headerPrefix: row.headerPrefix,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function ownerWhere(context: SessionSecretContext, includeArchived = false) {
  if (!context.userId) throw new Error('Secret unavailable');
  return and(
    eq(sessions.id, context.sessionId),
    eq(sessions.ownerKind, 'user'),
    eq(sessions.ownerUserId, context.userId),
    eq(users.id, context.userId),
    isNull(users.deletedAt),
    includeArchived ? undefined : isNull(sessions.archivedAt),
    context.fastConversationId
      ? eq(sessions.fastConversationId, context.fastConversationId)
      : undefined,
    // Keep attachment and actor checks in the grant query's own snapshot too.
    context.runId
      ? sql`exists (
      select 1 from ${taskRuns}
      inner join ${sessionTasks} on ${sessionTasks.taskId} = ${taskRuns.taskId}
      where ${taskRuns.id} = ${context.runId}
        and ${taskRuns.actingUserId} = ${users.id}
        and ${sessionTasks.sessionId} = ${sessions.id}
    )`
      : undefined,
  );
}

function pendingMetadata(
  row: typeof sessionSecretApprovals.$inferSelect,
): SessionSecretPendingMetadata {
  return {
    pendingRef: row.id,
    label: row.label,
    origin: row.origin,
    headerName: row.headerName,
    headerPrefix: row.headerPrefix,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertSessionSecretApproval(
  context: SessionSecretContext,
  input: SessionSecretPrepare,
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context))
      .for('share');
    if (!owner) throw new Error('Secret unavailable');
    const [row] = await tx
      .insert(sessionSecretApprovals)
      .values({
        sessionId: context.sessionId,
        ownerUserId: owner.id,
        label: input.label,
        origin: input.origin,
        headerName: input.headerName,
        headerPrefix: input.headerPrefix,
        expiresAt: sql`clock_timestamp() + ${input.ttlHours} * interval '1 hour'`,
      })
      .returning();
    if (!row) throw new Error('Secret unavailable');
    return pendingMetadata(row);
  });
}

export async function listOwnedSessionSecretApprovals(
  context: SessionSecretContext,
) {
  const secrets = await listOwnedSessionSecrets(context);
  const rows = await db
    .select({ pending: sessionSecretApprovals })
    .from(sessionSecretApprovals)
    .innerJoin(sessions, eq(sessions.id, sessionSecretApprovals.sessionId))
    .innerJoin(users, eq(users.id, sessionSecretApprovals.ownerUserId))
    .where(
      and(
        ownerWhere(context),
        eq(sessionSecretApprovals.ownerUserId, context.userId!),
        isNull(sessionSecretApprovals.consumedAt),
        gt(sessionSecretApprovals.expiresAt, sql`clock_timestamp()`),
      ),
    );
  return {
    pending: rows.map(({ pending }) => pendingMetadata(pending)),
    secrets,
  };
}

export async function finalizeSessionSecret(
  context: SessionSecretContext,
  input: SessionSecretCreate,
  validate: (pending: SessionSecretPendingMetadata) => void,
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context))
      .for('share');
    if (!owner) throw new Error('Secret unavailable');
    // A conditional UPDATE serializes concurrent finalizers; insertion failure rolls consumption back.
    const [pending] = await tx
      .update(sessionSecretApprovals)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(sessionSecretApprovals.id, input.pendingRef),
          eq(sessionSecretApprovals.sessionId, context.sessionId),
          eq(sessionSecretApprovals.ownerUserId, owner.id),
          isNull(sessionSecretApprovals.consumedAt),
          gt(sessionSecretApprovals.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!pending) throw new Error('Secret unavailable');
    validate(pendingMetadata(pending));
    const [row] = await tx
      .insert(sessionSecrets)
      .values({
        sessionId: context.sessionId,
        ownerUserId: owner.id,
        label: pending.label,
        origin: pending.origin,
        headerName: pending.headerName,
        headerPrefix: pending.headerPrefix,
        // Always treat human input as plaintext, even if it happens to be valid ciphertext.
        value: encrypt(input.secret),
        expiresAt: pending.expiresAt,
      })
      .returning(metadataColumns);
    if (!row) throw new Error('Secret unavailable');
    return metadata(row);
  });
}

export async function listOwnedSessionSecrets(context: SessionSecretContext) {
  const [owner] = await db
    .select({ id: users.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerUserId))
    .where(ownerWhere(context, true));
  if (!owner) throw new Error('Secret unavailable');
  const rows = await db
    .select(metadataColumns)
    .from(sessionSecrets)
    .innerJoin(sessions, eq(sessions.id, sessionSecrets.sessionId))
    .innerJoin(users, eq(users.id, sessionSecrets.ownerUserId))
    .where(
      and(ownerWhere(context, true), eq(sessionSecrets.ownerUserId, owner.id)),
    );
  return rows.map(metadata);
}

export async function revokeOwnedSessionSecret(
  context: SessionSecretContext,
  secretRef: string,
) {
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context, true))
      .for('share');
    if (!owner) throw new Error('Secret unavailable');
    const [row] = await tx
      .update(sessionSecrets)
      .set({
        revokedAt: sql`coalesce(${sessionSecrets.revokedAt}, now())`,
        value: null,
      })
      .where(
        and(
          eq(sessionSecrets.id, secretRef),
          eq(sessionSecrets.sessionId, context.sessionId),
          eq(sessionSecrets.ownerUserId, owner.id),
        ),
      )
      .returning({ id: sessionSecrets.id });
    if (!row) throw new Error('Secret unavailable');
  });
}

/** Ciphertext is decrypted only after the live actor/owner/Session/grant join. */
export async function resolveOwnedSessionSecret(
  context: SessionSecretContext,
  secretRef: string,
) {
  const [row] = await db
    .select({ secret: sessionSecrets })
    .from(sessionSecrets)
    .innerJoin(sessions, eq(sessions.id, sessionSecrets.sessionId))
    .innerJoin(users, eq(users.id, sessionSecrets.ownerUserId))
    .where(
      and(
        ownerWhere(context),
        eq(sessionSecrets.id, secretRef),
        eq(sessionSecrets.ownerUserId, context.userId!),
        isNull(sessionSecrets.revokedAt),
        gt(sessionSecrets.expiresAt, sql`clock_timestamp()`),
      ),
    );
  if (!row?.secret.value) throw new Error('Secret unavailable');
  return { ...metadata(row.secret), value: decrypt(row.secret.value) };
}

export async function recordSessionSecretAudit(
  input: Omit<typeof sessionSecretAudit.$inferInsert, 'createdAt'>,
) {
  // A final authorization check can correct completion to failed, never its metadata.
  await db
    .insert(sessionSecretAudit)
    .values(input)
    .onConflictDoUpdate({
      target: sessionSecretAudit.id,
      set: { outcome: input.outcome },
    });
}
