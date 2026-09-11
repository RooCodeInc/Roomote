import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import { getEncryptionKey } from '@roomote/env';
import {
  activeRunStatuses,
  SESSION_EGRESS_SUBSTITUTE_PREFIX,
  type RunStatus,
  type SessionEgressAuthorization,
  type SessionEgressAuthorize,
  type SessionEgressDenialReason,
  type SessionEgressRevocationFeed,
  type SessionEgressSubstituteIssue,
  type SessionEgressWorkloadRegister,
  type SessionEgressWorkloadRegistration,
  type SessionEgressWorkloadTerminate,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import {
  sessionEgressAudit,
  sessionEgressRevocations,
  sessionEgressSubstitutes,
  sessionEgressWorkloads,
  sessionSecrets,
  sessionTasks,
  sessions,
  taskRuns,
  users,
} from '../schema';
import { decrypt } from './encryption';

/**
 * Session egress control plane persistence.
 *
 * Trust model: every input here arrives from an authenticated controller or
 * gateway service principal, never from a sandbox, a Fast tool argument, or a
 * request header the workload could set. Even so, nothing below treats a
 * caller-supplied ID as authority on its own: each decision re-joins the live
 * owner, Session, attached run, grant, workload, and generation rows.
 *
 * Substitute tokens are random capabilities. Only a deployment-keyed hash is
 * stored; the plaintext is returned exactly once to the registering
 * controller and is otherwise unrecoverable.
 */

const ELIGIBLE_RUN_STATUSES = activeRunStatuses as readonly RunStatus[];

export class SessionEgressRegistrationError extends Error {
  constructor(readonly code: 'run_not_eligible' | 'connector_identity_in_use') {
    super(code);
    this.name = 'SessionEgressRegistrationError';
  }
}

/** Keyed so a database read alone cannot verify guessed tokens offline. */
export function hashSessionEgressSubstitute(token: string): string {
  return createHmac('sha256', getEncryptionKey()).update(token).digest('hex');
}

function mintSubstitute(): string {
  return `${SESSION_EGRESS_SUBSTITUTE_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const grantPolicyColumns = {
  secretRef: sessionSecrets.id,
  label: sessionSecrets.label,
  origin: sessionSecrets.origin,
  headerName: sessionSecrets.headerName,
  headerPrefix: sessionSecrets.headerPrefix,
  allowedMethods: sessionSecrets.allowedMethods,
  expiresAt: sessionSecrets.expiresAt,
};

/**
 * The single user-owned, unarchived Session an eligible run is attached to,
 * with the run's live actor equal to that owner. `session_tasks` keeps a task
 * on one Session; the length check fails closed should that ever loosen.
 */
async function eligibleRunSession(tx: DatabaseOrTransaction, runId: number) {
  const rows = await tx
    .select({ sessionId: sessions.id, ownerUserId: users.id })
    .from(taskRuns)
    .innerJoin(sessionTasks, eq(sessionTasks.taskId, taskRuns.taskId))
    .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
    .innerJoin(users, eq(users.id, taskRuns.actingUserId))
    .where(
      and(
        eq(taskRuns.id, runId),
        inArray(taskRuns.status, [...ELIGIBLE_RUN_STATUSES]),
        eq(sessions.ownerKind, 'user'),
        eq(sessions.ownerUserId, taskRuns.actingUserId),
        isNull(users.deletedAt),
        isNull(sessions.archivedAt),
      ),
    );
  return rows.length === 1 ? rows[0]! : null;
}

/** An active workload whose run, Session, owner, and attachment are all still live. */
async function liveWorkload(tx: DatabaseOrTransaction, workloadId: string) {
  const [row] = await tx
    .select({ workload: sessionEgressWorkloads })
    .from(sessionEgressWorkloads)
    .innerJoin(taskRuns, eq(taskRuns.id, sessionEgressWorkloads.taskRunId))
    .innerJoin(sessions, eq(sessions.id, sessionEgressWorkloads.sessionId))
    .innerJoin(users, eq(users.id, sessionEgressWorkloads.ownerUserId))
    .innerJoin(
      sessionTasks,
      and(
        eq(sessionTasks.sessionId, sessionEgressWorkloads.sessionId),
        eq(sessionTasks.taskId, taskRuns.taskId),
      ),
    )
    .where(
      and(
        eq(sessionEgressWorkloads.id, workloadId),
        eq(sessionEgressWorkloads.status, 'active'),
        gt(sessionEgressWorkloads.expiresAt, sql`clock_timestamp()`),
        inArray(taskRuns.status, [...ELIGIBLE_RUN_STATUSES]),
        eq(taskRuns.actingUserId, sessionEgressWorkloads.ownerUserId),
        eq(sessions.ownerKind, 'user'),
        eq(sessions.ownerUserId, sessionEgressWorkloads.ownerUserId),
        isNull(users.deletedAt),
        isNull(sessions.archivedAt),
      ),
    )
    .for('update', { of: sessionEgressWorkloads });
  return row?.workload ?? null;
}

async function retireSubstitutes(
  tx: DatabaseOrTransaction,
  workloadId: string,
  belowGeneration?: number,
) {
  await tx
    .update(sessionEgressSubstitutes)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(sessionEgressSubstitutes.workloadId, workloadId),
        isNull(sessionEgressSubstitutes.revokedAt),
        belowGeneration === undefined
          ? undefined
          : sql`${sessionEgressSubstitutes.generation} < ${belowGeneration}`,
      ),
    );
}

/**
 * Mint substitutes for every live grant of the workload's Session that has
 * no live substitute in the current generation. Returns plaintext once.
 */
async function mintMissingSubstitutes(
  tx: DatabaseOrTransaction,
  workload: typeof sessionEgressWorkloads.$inferSelect,
): Promise<SessionEgressSubstituteIssue[]> {
  const grants = await tx
    .select(grantPolicyColumns)
    .from(sessionSecrets)
    .where(
      and(
        eq(sessionSecrets.sessionId, workload.sessionId),
        eq(sessionSecrets.ownerUserId, workload.ownerUserId),
        isNull(sessionSecrets.revokedAt),
        gt(sessionSecrets.expiresAt, sql`clock_timestamp()`),
        sql`not exists (
          select 1 from ${sessionEgressSubstitutes}
          where ${sessionEgressSubstitutes.workloadId} = ${workload.id}
            and ${sessionEgressSubstitutes.secretId} = ${sessionSecrets.id}
            and ${sessionEgressSubstitutes.generation} = ${workload.generation}
            and ${sessionEgressSubstitutes.revokedAt} is null
        )`,
      ),
    )
    .orderBy(asc(sessionSecrets.createdAt));
  const issued: SessionEgressSubstituteIssue[] = [];
  for (const grant of grants) {
    const substitute = mintSubstitute();
    await tx.insert(sessionEgressSubstitutes).values({
      workloadId: workload.id,
      secretId: grant.secretRef,
      generation: workload.generation,
      tokenHash: hashSessionEgressSubstitute(substitute),
    });
    issued.push({
      secretRef: grant.secretRef,
      label: grant.label,
      origin: grant.origin,
      headerName: grant.headerName,
      headerPrefix: grant.headerPrefix,
      allowedMethods: [...grant.allowedMethods],
      expiresAt: grant.expiresAt.toISOString(),
      substitute,
    });
  }
  return issued;
}

function registration(
  workload: typeof sessionEgressWorkloads.$inferSelect,
  substitutes: SessionEgressSubstituteIssue[],
): SessionEgressWorkloadRegistration {
  return {
    workloadId: workload.id,
    sessionId: workload.sessionId,
    generation: workload.generation,
    expiresAt: workload.expiresAt.toISOString(),
    substitutes,
  };
}

/**
 * Register the attached run as an egress workload, or rotate it to a new
 * generation when it is already registered. Rotation invalidates every
 * earlier substitute; a run whose Session binding changed gets a fresh
 * workload after the stale one is terminated.
 */
export async function registerSessionEgressWorkload(
  input: SessionEgressWorkloadRegister,
): Promise<SessionEgressWorkloadRegistration> {
  return db.transaction(async (tx) => {
    // Serialize concurrent registrations of the same run.
    await tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.id, input.runId))
      .for('update');
    const eligible = await eligibleRunSession(tx, input.runId);
    if (!eligible) throw new SessionEgressRegistrationError('run_not_eligible');

    const [existing] = await tx
      .select()
      .from(sessionEgressWorkloads)
      .where(
        and(
          eq(sessionEgressWorkloads.taskRunId, input.runId),
          eq(sessionEgressWorkloads.status, 'active'),
        ),
      )
      .for('update');

    const [conflict] = await tx
      .select({ id: sessionEgressWorkloads.id })
      .from(sessionEgressWorkloads)
      .where(
        and(
          eq(sessionEgressWorkloads.connectorIdentity, input.connectorIdentity),
          eq(sessionEgressWorkloads.status, 'active'),
          existing ? ne(sessionEgressWorkloads.id, existing.id) : undefined,
        ),
      );
    if (conflict)
      throw new SessionEgressRegistrationError('connector_identity_in_use');

    const expiresAt = sql`clock_timestamp() + ${input.leaseSeconds} * interval '1 second'`;
    let workload: typeof sessionEgressWorkloads.$inferSelect | undefined;
    if (
      existing &&
      existing.sessionId === eligible.sessionId &&
      existing.ownerUserId === eligible.ownerUserId
    ) {
      [workload] = await tx
        .update(sessionEgressWorkloads)
        .set({
          generation: existing.generation + 1,
          provider: input.provider,
          connectorIdentity: input.connectorIdentity,
          expiresAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(sessionEgressWorkloads.id, existing.id))
        .returning();
      if (!workload)
        throw new SessionEgressRegistrationError('run_not_eligible');
      await retireSubstitutes(tx, workload.id, workload.generation);
      await tx.insert(sessionEgressRevocations).values({
        kind: 'generation',
        workloadId: workload.id,
        generation: workload.generation,
      });
    } else {
      if (existing) await terminate(tx, existing.id, 'detached');
      [workload] = await tx
        .insert(sessionEgressWorkloads)
        .values({
          sessionId: eligible.sessionId,
          ownerUserId: eligible.ownerUserId,
          taskRunId: input.runId,
          provider: input.provider,
          connectorIdentity: input.connectorIdentity,
          expiresAt,
        })
        .returning();
      if (!workload)
        throw new SessionEgressRegistrationError('run_not_eligible');
    }
    return registration(workload, await mintMissingSubstitutes(tx, workload));
  });
}

/** Substitutes for grants approved after registration, without rotating. */
export async function issueSessionEgressSubstitutes(
  workloadId: string,
): Promise<SessionEgressWorkloadRegistration | null> {
  return db.transaction(async (tx) => {
    const workload = await liveWorkload(tx, workloadId);
    if (!workload) return null;
    return registration(workload, await mintMissingSubstitutes(tx, workload));
  });
}

/** Leases are renewed by the controller only, and only while the binding is live. */
export async function renewSessionEgressWorkloadLease(
  workloadId: string,
  leaseSeconds: number,
): Promise<{
  workloadId: string;
  generation: number;
  expiresAt: string;
} | null> {
  return db.transaction(async (tx) => {
    const workload = await liveWorkload(tx, workloadId);
    if (!workload) return null;
    const [updated] = await tx
      .update(sessionEgressWorkloads)
      .set({
        expiresAt: sql`clock_timestamp() + ${leaseSeconds} * interval '1 second'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(sessionEgressWorkloads.id, workload.id))
      .returning();
    if (!updated) return null;
    return {
      workloadId: updated.id,
      generation: updated.generation,
      expiresAt: updated.expiresAt.toISOString(),
    };
  });
}

async function terminate(
  tx: DatabaseOrTransaction,
  workloadId: string,
  reason: SessionEgressWorkloadTerminate['reason'],
): Promise<boolean> {
  const [row] = await tx
    .update(sessionEgressWorkloads)
    .set({
      status: 'terminated',
      terminatedAt: sql`clock_timestamp()`,
      terminationReason: reason,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(sessionEgressWorkloads.id, workloadId),
        eq(sessionEgressWorkloads.status, 'active'),
      ),
    )
    .returning({ id: sessionEgressWorkloads.id });
  if (!row) return false;
  await retireSubstitutes(tx, row.id);
  await tx
    .insert(sessionEgressRevocations)
    .values({ kind: 'workload', workloadId: row.id });
  return true;
}

export async function terminateSessionEgressWorkload(
  workloadId: string,
  reason: SessionEgressWorkloadTerminate['reason'],
): Promise<boolean> {
  return db.transaction((tx) => terminate(tx, workloadId, reason));
}

export async function listSessionEgressRevocations(
  after: number,
  limit: number,
): Promise<SessionEgressRevocationFeed> {
  const rows = await db
    .select()
    .from(sessionEgressRevocations)
    .where(gt(sessionEgressRevocations.id, after))
    .orderBy(asc(sessionEgressRevocations.id))
    .limit(limit);
  return {
    events: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      workloadId: row.workloadId,
      secretRef: row.secretRef,
      generation: row.generation,
      createdAt: row.createdAt.toISOString(),
    })),
    cursor: rows.at(-1)?.id ?? after,
  };
}

function approvedDestination(origin: string): { host: string; port: number } {
  const url = new URL(origin);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : 443,
  };
}

/**
 * Live per-request authorization for the gateway. Every phase of one HTTP
 * exchange (request, buffered response release, each stream emission) calls
 * this again; nothing here is cached. Plaintext is decrypted only after the
 * whole decision is `allowed`, and only for the `request` phase.
 */
export async function authorizeSessionEgress(
  input: SessionEgressAuthorize,
  options: {
    /**
     * Current deployment egress policy for the approved origin (public
     * address, HTTPS). Approval-time validation is not enough: policy can
     * tighten after a grant exists, and the gateway's own dial guard is a
     * second line, not the only one.
     */
    isOriginAllowed?: (origin: string) => boolean;
  } = {},
): Promise<SessionEgressAuthorization> {
  const load = () =>
    db
      .select({
        substitute: sessionEgressSubstitutes,
        workload: sessionEgressWorkloads,
        secret: sessionSecrets,
        session: {
          ownerKind: sessions.ownerKind,
          ownerUserId: sessions.ownerUserId,
          archivedAt: sessions.archivedAt,
        },
        ownerDeletedAt: users.deletedAt,
        run: { actingUserId: taskRuns.actingUserId, status: taskRuns.status },
        attached: sql<boolean>`exists (
        select 1 from ${sessionTasks}
        where ${sessionTasks.sessionId} = ${sessionEgressWorkloads.sessionId}
          and ${sessionTasks.taskId} = ${taskRuns.taskId}
      )`,
        workloadExpired: sql<boolean>`${sessionEgressWorkloads.expiresAt} <= clock_timestamp()`,
        grantExpired: sql<boolean>`${sessionSecrets.expiresAt} <= clock_timestamp()`,
      })
      .from(sessionEgressSubstitutes)
      .innerJoin(
        sessionEgressWorkloads,
        eq(sessionEgressWorkloads.id, sessionEgressSubstitutes.workloadId),
      )
      .innerJoin(
        sessionSecrets,
        eq(sessionSecrets.id, sessionEgressSubstitutes.secretId),
      )
      .innerJoin(sessions, eq(sessions.id, sessionEgressWorkloads.sessionId))
      .innerJoin(users, eq(users.id, sessionEgressWorkloads.ownerUserId))
      .innerJoin(taskRuns, eq(taskRuns.id, sessionEgressWorkloads.taskRunId))
      .where(
        eq(
          sessionEgressSubstitutes.tokenHash,
          hashSessionEgressSubstitute(input.substitute),
        ),
      );

  const decide = (
    row: Awaited<ReturnType<typeof load>>[number] | undefined,
  ): SessionEgressDenialReason | null => {
    if (!row) return 'unknown_substitute';
    const { substitute, workload, secret, session, run } = row;
    if (
      workload.id !== input.workloadId ||
      workload.connectorIdentity !== input.connectorIdentity
    )
      return 'workload_mismatch';
    if (workload.status !== 'active' || row.workloadExpired)
      return 'workload_inactive';
    if (substitute.generation !== workload.generation)
      return 'stale_generation';
    if (secret.revokedAt || substitute.revokedAt || !secret.value)
      return 'grant_revoked';
    if (row.grantExpired) return 'grant_expired';
    if (
      session.ownerKind !== 'user' ||
      session.ownerUserId !== workload.ownerUserId ||
      secret.ownerUserId !== workload.ownerUserId ||
      secret.sessionId !== workload.sessionId ||
      session.archivedAt ||
      row.ownerDeletedAt ||
      run.actingUserId !== workload.ownerUserId ||
      !ELIGIBLE_RUN_STATUSES.includes(run.status) ||
      !row.attached
    )
      return 'session_unavailable';
    const expected = approvedDestination(secret.origin);
    if (
      input.destination.host.toLowerCase() !== expected.host ||
      input.destination.port !== expected.port ||
      !(options.isOriginAllowed?.(secret.origin) ?? true)
    )
      return 'destination_mismatch';
    if (!(secret.allowedMethods as readonly string[]).includes(input.method))
      return 'method_not_allowed';
    return null;
  };

  const [row] = await load();
  const reason = decide(row);
  const authorizationId = input.authorizationId ?? randomUUID();
  // A token that does not belong to this workload tells the audit nothing
  // trustworthy about a Session or grant; record only the presented workload.
  const bound =
    row && reason !== 'unknown_substitute' && reason !== 'workload_mismatch';
  await db.insert(sessionEgressAudit).values({
    authorizationId,
    workloadId: input.workloadId,
    sessionId: bound ? row.workload.sessionId : null,
    actorUserId: bound ? row.workload.ownerUserId : null,
    secretRef: bound ? row.secret.id : null,
    phase: input.phase,
    method: input.method,
    destination: `${input.destination.host.toLowerCase()}:${input.destination.port}`,
    decision: reason ? 'denied' : 'allowed',
    reason,
  });
  if (reason || !row) return { allowed: false, reason: reason ?? 'malformed' };

  // The audit write can wait behind a lock while any binding above changes.
  // Its row records an evaluation attempt, not a release. The final READ
  // COMMITTED snapshot is the decision point; never await again on allow.
  const [finalRow] = await load();
  const finalReason = decide(finalRow);
  if (finalReason || !finalRow)
    return { allowed: false, reason: finalReason ?? 'malformed' };

  return {
    allowed: true,
    authorizationId,
    workloadId: finalRow.workload.id,
    generation: finalRow.workload.generation,
    sessionId: finalRow.workload.sessionId,
    secretRef: finalRow.secret.id,
    // Earliest of grant expiry and workload lease: no stream outlives either.
    expiresAt: new Date(
      Math.min(
        finalRow.secret.expiresAt.getTime(),
        finalRow.workload.expiresAt.getTime(),
      ),
    ).toISOString(),
    ...(input.phase === 'request'
      ? {
          credential: {
            headerName: finalRow.secret.headerName,
            headerPrefix: finalRow.secret.headerPrefix,
            value: decrypt(finalRow.secret.value!),
          },
        }
      : {}),
  };
}

/** Audit rows for one workload: bounded codes only, for tests and operator tooling. */
export async function listSessionEgressAudit(workloadId: string) {
  return db
    .select()
    .from(sessionEgressAudit)
    .where(eq(sessionEgressAudit.workloadId, workloadId))
    .orderBy(asc(sessionEgressAudit.createdAt));
}
