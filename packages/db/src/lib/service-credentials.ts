import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import {
  SERVICE_CREDENTIAL_APPROVAL_WINDOW_HOURS,
  type IntegrationCreate,
  type ServiceCredentialCreate,
  type ServiceCredentialPrepare,
  type ServiceCredentialPendingMetadata,
  type ServiceCredentialMetadata,
  type CredentialEgressMethod,
} from '@roomote/types';

import { db } from '../db';
import {
  credentialEgressRevocations,
  credentialEgressSubstitutes,
  serviceCredentialApprovals,
  serviceCredentialAudit,
  serviceCredentials,
  sessions,
  users,
  sessionTasks,
  taskRuns,
} from '../schema';
import { decrypt, encrypt } from './encryption';

/** Trusted server context only. Never deserialize this from tool arguments. */
export interface ServiceCredentialContext {
  sessionId: string;
  userId: string | null | undefined;
  runId?: number;
  fastConversationId?: string;
}

/** Bounded, nonsecret reasons a Integration-key operation fails closed. */
type ServiceCredentialUnavailableReason =
  | 'actor_missing'
  | 'run_not_bound'
  | 'session_not_bound'
  | 'owner_not_found'
  | 'approval_not_found'
  | 'grant_not_found'
  | 'write_failed';

/**
 * Every fail-closed path throws this with one generic message, so callers keep
 * relaying nothing to clients while server logs can record `reason`.
 */
export class ServiceCredentialUnavailableError extends Error {
  readonly reason: ServiceCredentialUnavailableReason;

  constructor(reason: ServiceCredentialUnavailableReason) {
    super('Secret unavailable');
    this.name = 'ServiceCredentialUnavailableError';
    this.reason = reason;
  }
}

/** Resolve only signed server context. A caller-supplied Session ID is not authority. */
export async function resolveServiceCredentialContext(
  auth:
    | {
        tokenType: 'session-broker';
        userId: string;
        fastConversationId: string;
      }
    | { tokenType: 'run'; runId: number; userId: string | null },
): Promise<ServiceCredentialContext> {
  if (!auth.userId)
    throw new ServiceCredentialUnavailableError('actor_missing');
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
              // Task access alone must not let a collaborator use the owner's key.
              eq(taskRuns.actingUserId, auth.userId),
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
  if (!row?.userId)
    throw new ServiceCredentialUnavailableError(
      auth.tokenType === 'run' ? 'run_not_bound' : 'session_not_bound',
    );
  return {
    ...row,
    ...(auth.tokenType === 'run'
      ? { runId: auth.runId }
      : { fastConversationId: auth.fastConversationId }),
  };
}

const metadataColumns = {
  secretRef: serviceCredentials.id,
  label: serviceCredentials.label,
  origin: serviceCredentials.origin,
  headerName: serviceCredentials.headerName,
  headerPrefix: serviceCredentials.headerPrefix,
  allowedMethods: serviceCredentials.allowedMethods,
  expiresAt: serviceCredentials.expiresAt,
  revokedAt: serviceCredentials.revokedAt,
  createdAt: serviceCredentials.createdAt,
};

function metadata(
  row:
    | typeof serviceCredentials.$inferSelect
    | {
        secretRef: string;
        label: string;
        origin: string;
        headerName: ServiceCredentialPrepare['headerName'];
        headerPrefix: ServiceCredentialPrepare['headerPrefix'];
        allowedMethods: CredentialEgressMethod[];
        expiresAt: Date | null;
        revokedAt: Date | null;
        createdAt: Date;
      },
): ServiceCredentialMetadata {
  return {
    secretRef: 'secretRef' in row ? row.secretRef : row.id,
    label: row.label,
    origin: row.origin,
    headerName: row.headerName,
    headerPrefix: row.headerPrefix,
    allowedMethods: [...row.allowedMethods],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function ownerWhere(
  context: ServiceCredentialContext,
  includeArchived = false,
) {
  if (!context.userId)
    throw new ServiceCredentialUnavailableError('actor_missing');
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
  row: typeof serviceCredentialApprovals.$inferSelect,
): ServiceCredentialPendingMetadata {
  return {
    pendingRef: row.id,
    label: row.label,
    origin: row.origin,
    headerName: row.headerName,
    headerPrefix: row.headerPrefix,
    allowedMethods: [...row.allowedMethods],
    lifetimeHours: row.lifetimeHours,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Grant expiry from an optional lifetime; null keeps the integration until revoked. */
function lifetimeExpiry(lifetimeHours: number | null | undefined) {
  return lifetimeHours
    ? sql`clock_timestamp() + ${lifetimeHours} * interval '1 hour'`
    : null;
}

/** A live grant: not revoked and either permanent or not yet expired. */
function liveGrantWhere() {
  return and(
    isNull(serviceCredentials.revokedAt),
    or(
      isNull(serviceCredentials.expiresAt),
      gt(serviceCredentials.expiresAt, sql`clock_timestamp()`),
    ),
  );
}

async function retireGrantSubstitutes(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  secretId: string,
) {
  // Live authorization already denies a revoked grant; retiring substitutes
  // and recording the event only accelerates in-flight cancellation.
  await tx
    .update(credentialEgressSubstitutes)
    .set({
      revokedAt: sql`coalesce(${credentialEgressSubstitutes.revokedAt}, now())`,
    })
    .where(eq(credentialEgressSubstitutes.secretId, secretId));
  await tx
    .insert(credentialEgressRevocations)
    .values({ kind: 'grant', secretRef: secretId });
}

export async function insertServiceCredentialApproval(
  context: ServiceCredentialContext,
  input: ServiceCredentialPrepare,
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context))
      .for('share');
    if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
    const [row] = await tx
      .insert(serviceCredentialApprovals)
      .values({
        sessionId: context.sessionId,
        ownerUserId: owner.id,
        label: input.label,
        origin: input.origin,
        headerName: input.headerName,
        headerPrefix: input.headerPrefix,
        allowedMethods: input.allowedMethods,
        lifetimeHours: input.lifetimeHours ?? null,
        expiresAt: sql`clock_timestamp() + ${SERVICE_CREDENTIAL_APPROVAL_WINDOW_HOURS} * interval '1 hour'`,
      })
      .returning();
    if (!row) throw new ServiceCredentialUnavailableError('write_failed');
    return pendingMetadata(row);
  });
}

export async function listOwnedServiceCredentialApprovals(
  context: ServiceCredentialContext,
) {
  const secrets = await listOwnedServiceCredentials(context);
  const rows = await db
    .select({ pending: serviceCredentialApprovals })
    .from(serviceCredentialApprovals)
    .innerJoin(sessions, eq(sessions.id, serviceCredentialApprovals.sessionId))
    .innerJoin(users, eq(users.id, serviceCredentialApprovals.ownerUserId))
    .where(
      and(
        ownerWhere(context),
        eq(serviceCredentialApprovals.ownerUserId, context.userId!),
        isNull(serviceCredentialApprovals.consumedAt),
        gt(serviceCredentialApprovals.expiresAt, sql`clock_timestamp()`),
      ),
    );
  return {
    pending: rows.map(({ pending }) => pendingMetadata(pending)),
    secrets,
  };
}

export async function finalizeServiceCredential(
  context: ServiceCredentialContext,
  input: ServiceCredentialCreate,
  validate: (pending: ServiceCredentialPendingMetadata) => void,
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context))
      .for('share');
    if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
    // A conditional UPDATE serializes concurrent finalizers; insertion failure rolls consumption back.
    const [pending] = await tx
      .update(serviceCredentialApprovals)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(serviceCredentialApprovals.id, input.pendingRef),
          eq(serviceCredentialApprovals.sessionId, context.sessionId),
          eq(serviceCredentialApprovals.ownerUserId, owner.id),
          isNull(serviceCredentialApprovals.consumedAt),
          gt(serviceCredentialApprovals.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!pending)
      throw new ServiceCredentialUnavailableError('approval_not_found');
    validate(pendingMetadata(pending));
    const [row] = await tx
      .insert(serviceCredentials)
      .values({
        sessionId: context.sessionId,
        ownerUserId: owner.id,
        label: pending.label,
        origin: pending.origin,
        headerName: pending.headerName,
        headerPrefix: pending.headerPrefix,
        // The policy is copied from the immutable prepared approval, never from the finalizer.
        allowedMethods: pending.allowedMethods,
        // Always treat human input as plaintext, even if it happens to be valid ciphertext.
        value: encrypt(input.secret),
        expiresAt: lifetimeExpiry(pending.lifetimeHours),
      })
      .returning(metadataColumns);
    if (!row) throw new ServiceCredentialUnavailableError('write_failed');
    return metadata(row);
  });
}

/** Every integration of the Session's owner: approved in any Session or added from Settings. */
export async function listOwnedServiceCredentials(
  context: ServiceCredentialContext,
) {
  const [owner] = await db
    .select({ id: users.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerUserId))
    .where(ownerWhere(context, true));
  if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
  return listUserIntegrations(owner.id);
}

export async function listUserIntegrations(userId: string) {
  const rows = await db
    .select(metadataColumns)
    .from(serviceCredentials)
    .innerJoin(users, eq(users.id, serviceCredentials.ownerUserId))
    .where(
      and(eq(serviceCredentials.ownerUserId, userId), isNull(users.deletedAt)),
    )
    .orderBy(asc(serviceCredentials.createdAt));
  return rows.map(metadata);
}

/** Settings path: policy and key arrive together from the owner; no approval is involved. */
export async function insertUserIntegration(
  userId: string,
  input: IntegrationCreate & { origin: string },
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('share');
    if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
    const [row] = await tx
      .insert(serviceCredentials)
      .values({
        sessionId: null,
        ownerUserId: owner.id,
        label: input.label,
        origin: input.origin,
        headerName: input.headerName,
        headerPrefix: input.headerPrefix,
        allowedMethods: input.allowedMethods,
        value: encrypt(input.secret),
        expiresAt: lifetimeExpiry(input.lifetimeHours),
      })
      .returning(metadataColumns);
    if (!row) throw new ServiceCredentialUnavailableError('write_failed');
    return metadata(row);
  });
}

export async function revokeUserIntegration(userId: string, secretRef: string) {
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('share');
    if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
    const [row] = await tx
      .update(serviceCredentials)
      .set({
        revokedAt: sql`coalesce(${serviceCredentials.revokedAt}, now())`,
        value: null,
      })
      .where(
        and(
          eq(serviceCredentials.id, secretRef),
          eq(serviceCredentials.ownerUserId, owner.id),
        ),
      )
      .returning({ id: serviceCredentials.id });
    if (!row) throw new ServiceCredentialUnavailableError('grant_not_found');
    await retireGrantSubstitutes(tx, row.id);
  });
}

export async function revokeOwnedServiceCredential(
  context: ServiceCredentialContext,
  secretRef: string,
) {
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerUserId))
      .where(ownerWhere(context, true))
      .for('share');
    if (!owner) throw new ServiceCredentialUnavailableError('owner_not_found');
    const [row] = await tx
      .update(serviceCredentials)
      .set({
        revokedAt: sql`coalesce(${serviceCredentials.revokedAt}, now())`,
        value: null,
      })
      .where(
        and(
          eq(serviceCredentials.id, secretRef),
          eq(serviceCredentials.ownerUserId, owner.id),
        ),
      )
      .returning({ id: serviceCredentials.id });
    if (!row) throw new ServiceCredentialUnavailableError('grant_not_found');
    await retireGrantSubstitutes(tx, row.id);
  });
}

/** Ciphertext is decrypted only after the live actor/owner/Session and grant checks. */
export async function resolveOwnedServiceCredential(
  context: ServiceCredentialContext,
  secretRef: string,
) {
  const [owner] = await db
    .select({ id: users.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerUserId))
    .where(ownerWhere(context));
  if (!owner) throw new ServiceCredentialUnavailableError('grant_not_found');
  const [row] = await db
    .select({ secret: serviceCredentials })
    .from(serviceCredentials)
    .where(
      and(
        eq(serviceCredentials.id, secretRef),
        eq(serviceCredentials.ownerUserId, owner.id),
        liveGrantWhere(),
      ),
    );
  if (!row?.secret.value)
    throw new ServiceCredentialUnavailableError('grant_not_found');
  return { ...metadata(row.secret), value: decrypt(row.secret.value) };
}

export async function recordServiceCredentialAudit(
  input: Omit<typeof serviceCredentialAudit.$inferInsert, 'createdAt'>,
) {
  // A final authorization check can correct completion to failed, never its metadata.
  await db
    .insert(serviceCredentialAudit)
    .values(input)
    .onConflictDoUpdate({
      target: serviceCredentialAudit.id,
      set: { outcome: input.outcome },
    });
}
