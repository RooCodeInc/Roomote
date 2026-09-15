import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { getEncryptionKey } from '@roomote/env';
import {
  activeRunStatuses,
  isServiceCredentialToolsExperimentEnabled,
  CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX,
  type RunStatus,
  type CredentialEgressAuthorization,
  type CredentialEgressDenialReason,
  type CredentialEgressProxyAuthorize,
  type CredentialEgressSubstituteIssue,
  type CredentialEgressWorkloadRegister,
  type CredentialEgressWorkloadRegistration,
  type CredentialEgressWorkloadTerminate,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import {
  credentialEgressAudit,
  credentialEgressRevocations,
  credentialEgressSubstitutes,
  credentialEgressWorkloads,
  serviceCredentials,
  sessionTasks,
  sessions,
  taskRuns,
  users,
} from '../schema';
import { decrypt } from './encryption';

/**
 * Credential egress control plane persistence.
 *
 * Trust model: every input here arrives from the authenticated controller or
 * from the API's own substitution proxy, never from a sandbox, a Fast tool
 * argument, or a request header the workload could set. Even so, nothing below treats a
 * caller-supplied ID as authority on its own: each decision re-joins the live
 * owner, Session, attached run, grant, workload, and generation rows.
 *
 * Substitute tokens are random capabilities. Only a deployment-keyed hash is
 * stored; the plaintext is returned exactly once to the registering
 * controller and is otherwise unrecoverable.
 */

const ELIGIBLE_RUN_STATUSES = activeRunStatuses as readonly RunStatus[];

export class CredentialEgressRegistrationError extends Error {
  constructor(readonly code: 'run_not_eligible' | 'connector_identity_in_use') {
    super(code);
    this.name = 'CredentialEgressRegistrationError';
  }
}

/** Keyed so a database read alone cannot verify guessed tokens offline. */
export function hashCredentialEgressSubstitute(token: string): string {
  return createHmac('sha256', getEncryptionKey()).update(token).digest('hex');
}

function mintSubstitute(): string {
  return `${CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const grantPolicyColumns = {
  secretRef: serviceCredentials.id,
  label: serviceCredentials.label,
  origin: serviceCredentials.origin,
  headerName: serviceCredentials.headerName,
  headerPrefix: serviceCredentials.headerPrefix,
  allowedMethods: serviceCredentials.allowedMethods,
  expiresAt: serviceCredentials.expiresAt,
};

/**
 * The single user-owned, unarchived Session an eligible run is attached to,
 * with the run's live actor equal to that owner. `session_tasks` keeps a task
 * on one Session; the length check fails closed should that ever loosen.
 */
async function eligibleRunSession(tx: DatabaseOrTransaction, runId: number) {
  const rows = await tx
    .select({
      sessionId: sessions.id,
      ownerUserId: users.id,
      ownerMetadata: users.metadata,
    })
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

/**
 * Controller preflight: is this run attached to a Session that could receive
 * substitutes, has its owner enabled integration keys, and how many live
 * grants would it get? Runs with no such Session are ordinary runs and never
 * contact the control plane; runs with a Session but zero grants are
 * reported, not registered (grants approved mid-run take effect at the next
 * start or resume). The owner's experiment setting gates delivery the same
 * way it gates the Fast and coding-run tools.
 */
export async function findCredentialEgressCandidateForRun(
  runId: number,
): Promise<{
  sessionId: string;
  grantCount: number;
  experimentEnabled: boolean;
} | null> {
  const eligible = await eligibleRunSession(db, runId);
  if (!eligible) return null;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(serviceCredentials)
    .where(
      and(
        // Every integration of the owner, whichever Session approved it.
        eq(serviceCredentials.ownerUserId, eligible.ownerUserId),
        isNull(serviceCredentials.revokedAt),
        or(
          isNull(serviceCredentials.expiresAt),
          gt(serviceCredentials.expiresAt, sql`clock_timestamp()`),
        ),
      ),
    );
  return {
    sessionId: eligible.sessionId,
    grantCount: row?.count ?? 0,
    experimentEnabled: isServiceCredentialToolsExperimentEnabled(
      eligible.ownerMetadata,
    ),
  };
}

/**
 * The owner's Integration-key-tools setting, read under a share lock so a
 * concurrent toggle blocks until this transaction commits. Every path that
 * mints or extends substitutes calls this inside its transaction; the
 * controller's preflight read is planning only.
 */
async function ownerExperimentLocked(
  tx: DatabaseOrTransaction,
  ownerUserId: string,
): Promise<boolean> {
  const [owner] = await tx
    .select({ metadata: users.metadata })
    .from(users)
    .where(and(eq(users.id, ownerUserId), isNull(users.deletedAt)))
    .for('share');
  return (
    Boolean(owner) && isServiceCredentialToolsExperimentEnabled(owner!.metadata)
  );
}

/** An active workload whose run, Session, owner, and attachment are all still live. */
async function liveWorkload(tx: DatabaseOrTransaction, workloadId: string) {
  const [row] = await tx
    .select({ workload: credentialEgressWorkloads })
    .from(credentialEgressWorkloads)
    .innerJoin(taskRuns, eq(taskRuns.id, credentialEgressWorkloads.taskRunId))
    .innerJoin(sessions, eq(sessions.id, credentialEgressWorkloads.sessionId))
    .innerJoin(users, eq(users.id, credentialEgressWorkloads.ownerUserId))
    .innerJoin(
      sessionTasks,
      and(
        eq(sessionTasks.sessionId, credentialEgressWorkloads.sessionId),
        eq(sessionTasks.taskId, taskRuns.taskId),
      ),
    )
    .where(
      and(
        eq(credentialEgressWorkloads.id, workloadId),
        eq(credentialEgressWorkloads.status, 'active'),
        gt(credentialEgressWorkloads.expiresAt, sql`clock_timestamp()`),
        inArray(taskRuns.status, [...ELIGIBLE_RUN_STATUSES]),
        eq(taskRuns.actingUserId, credentialEgressWorkloads.ownerUserId),
        eq(sessions.ownerKind, 'user'),
        eq(sessions.ownerUserId, credentialEgressWorkloads.ownerUserId),
        isNull(users.deletedAt),
        isNull(sessions.archivedAt),
      ),
    )
    .for('update', { of: credentialEgressWorkloads });
  // The owner's experiment gates the tools per request; a workload is only
  // live while it stays on, so renewals and new substitutes stop with it.
  if (!row) return null;
  return (await ownerExperimentLocked(tx, row.workload.ownerUserId))
    ? row.workload
    : null;
}

/** Authorization for controller-to-worker delivery of substitute-only client config. */
export async function isCredentialEgressDeliveryCurrent(input: {
  workloadId: string;
  generation: number;
  runId: number;
  signedUserId?: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await liveWorkload(tx, input.workloadId);
    return Boolean(
      row &&
      row.taskRunId === input.runId &&
      row.generation === input.generation &&
      (input.signedUserId === undefined ||
        row.ownerUserId === input.signedUserId),
    );
  });
}

async function retireSubstitutes(
  tx: DatabaseOrTransaction,
  workloadId: string,
  belowGeneration?: number,
) {
  await tx
    .update(credentialEgressSubstitutes)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(credentialEgressSubstitutes.workloadId, workloadId),
        isNull(credentialEgressSubstitutes.revokedAt),
        belowGeneration === undefined
          ? undefined
          : sql`${credentialEgressSubstitutes.generation} < ${belowGeneration}`,
      ),
    );
}

/**
 * Mint substitutes for every live grant of the workload's Session that has
 * no live substitute in the current generation. Returns plaintext once.
 */
async function mintMissingSubstitutes(
  tx: DatabaseOrTransaction,
  workload: typeof credentialEgressWorkloads.$inferSelect,
  isOriginAllowed: (origin: string) => boolean,
): Promise<CredentialEgressSubstituteIssue[]> {
  const grants = await tx
    .select(grantPolicyColumns)
    .from(serviceCredentials)
    .where(
      and(
        eq(serviceCredentials.ownerUserId, workload.ownerUserId),
        isNull(serviceCredentials.revokedAt),
        or(
          isNull(serviceCredentials.expiresAt),
          gt(serviceCredentials.expiresAt, sql`clock_timestamp()`),
        ),
        sql`not exists (
          select 1 from ${credentialEgressSubstitutes}
          where ${credentialEgressSubstitutes.workloadId} = ${workload.id}
            and ${credentialEgressSubstitutes.secretId} = ${serviceCredentials.id}
            and ${credentialEgressSubstitutes.generation} = ${workload.generation}
            and ${credentialEgressSubstitutes.revokedAt} is null
        )`,
      ),
    )
    .orderBy(asc(serviceCredentials.createdAt));
  const issued: CredentialEgressSubstituteIssue[] = [];
  // Minting is the write boundary: the owner row is already share-locked by
  // the caller's transaction, so this re-read cannot observe a newer toggle
  // and simply refuses to write for an owner whose tools are off.
  if (
    grants.length > 0 &&
    !(await ownerExperimentLocked(tx, workload.ownerUserId))
  )
    return issued;
  for (const grant of grants) {
    // Withheld plaintext is unrecoverable, so denied grants must remain mintable.
    if (!isOriginAllowed(grant.origin)) continue;
    const substitute = mintSubstitute();
    await tx.insert(credentialEgressSubstitutes).values({
      workloadId: workload.id,
      secretId: grant.secretRef,
      generation: workload.generation,
      tokenHash: hashCredentialEgressSubstitute(substitute),
    });
    issued.push({
      secretRef: grant.secretRef,
      label: grant.label,
      origin: grant.origin,
      headerName: grant.headerName,
      headerPrefix: grant.headerPrefix,
      allowedMethods: [...grant.allowedMethods],
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      substitute,
    });
  }
  return issued;
}

function registration(
  workload: typeof credentialEgressWorkloads.$inferSelect,
  substitutes: CredentialEgressSubstituteIssue[],
): CredentialEgressWorkloadRegistration {
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
export async function registerCredentialEgressWorkload(
  input: CredentialEgressWorkloadRegister,
  options: { isOriginAllowed?: (origin: string) => boolean } = {},
): Promise<CredentialEgressWorkloadRegistration> {
  return db.transaction(async (tx) => {
    // Serialize concurrent registrations of the same run.
    await tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.id, input.runId))
      .for('update');
    const eligible = await eligibleRunSession(tx, input.runId);
    // The controller's preflight is planning only. The owner row is locked
    // here for the rest of the transaction, so a toggle that lands between
    // this read and the mint waits for the commit and then governs the next
    // live check; nothing is minted for an owner who already turned it off.
    if (!eligible || !(await ownerExperimentLocked(tx, eligible.ownerUserId)))
      throw new CredentialEgressRegistrationError('run_not_eligible');

    const [existing] = await tx
      .select()
      .from(credentialEgressWorkloads)
      .where(
        and(
          eq(credentialEgressWorkloads.taskRunId, input.runId),
          eq(credentialEgressWorkloads.status, 'active'),
        ),
      )
      .for('update');

    const [conflict] = await tx
      .select({ id: credentialEgressWorkloads.id })
      .from(credentialEgressWorkloads)
      .where(
        and(
          eq(
            credentialEgressWorkloads.connectorIdentity,
            input.connectorIdentity,
          ),
          eq(credentialEgressWorkloads.status, 'active'),
          existing ? ne(credentialEgressWorkloads.id, existing.id) : undefined,
        ),
      );
    if (conflict)
      throw new CredentialEgressRegistrationError('connector_identity_in_use');

    const expiresAt = sql`clock_timestamp() + ${input.leaseSeconds} * interval '1 second'`;
    let workload: typeof credentialEgressWorkloads.$inferSelect | undefined;
    if (
      existing &&
      existing.sessionId === eligible.sessionId &&
      existing.ownerUserId === eligible.ownerUserId
    ) {
      [workload] = await tx
        .update(credentialEgressWorkloads)
        .set({
          generation: existing.generation + 1,
          provider: input.provider,
          connectorIdentity: input.connectorIdentity,
          expiresAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(credentialEgressWorkloads.id, existing.id))
        .returning();
      if (!workload)
        throw new CredentialEgressRegistrationError('run_not_eligible');
      await retireSubstitutes(tx, workload.id, workload.generation);
      await tx.insert(credentialEgressRevocations).values({
        kind: 'generation',
        workloadId: workload.id,
        generation: workload.generation,
      });
    } else {
      if (existing) await terminate(tx, existing.id, 'detached');
      [workload] = await tx
        .insert(credentialEgressWorkloads)
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
        throw new CredentialEgressRegistrationError('run_not_eligible');
    }
    return registration(
      workload,
      await mintMissingSubstitutes(
        tx,
        workload,
        options.isOriginAllowed ?? (() => true),
      ),
    );
  });
}

/** Substitutes for grants approved after registration, without rotating. */
export async function issueCredentialEgressSubstitutes(
  workloadId: string,
  options: { isOriginAllowed?: (origin: string) => boolean } = {},
): Promise<CredentialEgressWorkloadRegistration | null> {
  return db.transaction(async (tx) => {
    const workload = await liveWorkload(tx, workloadId);
    if (!workload) return null;
    return registration(
      workload,
      await mintMissingSubstitutes(
        tx,
        workload,
        options.isOriginAllowed ?? (() => true),
      ),
    );
  });
}

/** Leases are renewed by the controller only, and only while the binding is live. */
export async function renewCredentialEgressWorkloadLease(
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
      .update(credentialEgressWorkloads)
      .set({
        expiresAt: sql`clock_timestamp() + ${leaseSeconds} * interval '1 second'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(credentialEgressWorkloads.id, workload.id))
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
  reason: CredentialEgressWorkloadTerminate['reason'],
): Promise<boolean> {
  const [row] = await tx
    .update(credentialEgressWorkloads)
    .set({
      status: 'terminated',
      terminatedAt: sql`clock_timestamp()`,
      terminationReason: reason,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(credentialEgressWorkloads.id, workloadId),
        eq(credentialEgressWorkloads.status, 'active'),
      ),
    )
    .returning({ id: credentialEgressWorkloads.id });
  if (!row) return false;
  await retireSubstitutes(tx, row.id);
  await tx
    .insert(credentialEgressRevocations)
    .values({ kind: 'workload', workloadId: row.id });
  return true;
}

export async function terminateCredentialEgressWorkload(
  workloadId: string,
  reason: CredentialEgressWorkloadTerminate['reason'],
): Promise<boolean> {
  return db.transaction((tx) => terminate(tx, workloadId, reason));
}

/**
 * Terminate every active workload bound to a run. Used by the centralized
 * run-finalization path (stop, completion, failure, cancel, standby) so a
 * workload never outlives its run regardless of which process observed the
 * transition. Returns the terminated workload ids.
 */
export async function terminateCredentialEgressWorkloadsForRun(
  runId: number,
  reason: CredentialEgressWorkloadTerminate['reason'],
  database: DatabaseOrTransaction = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: credentialEgressWorkloads.id })
    .from(credentialEgressWorkloads)
    .where(
      and(
        eq(credentialEgressWorkloads.taskRunId, runId),
        eq(credentialEgressWorkloads.status, 'active'),
      ),
    );
  const terminated: string[] = [];
  for (const row of rows) {
    if (await terminate(database, row.id, reason)) terminated.push(row.id);
  }
  return terminated;
}

function approvedDestination(origin: string): { host: string; port: number } {
  const url = new URL(origin);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : 443,
  };
}

/**
 * Live per-request authorization. Every phase of one HTTP exchange (request,
 * buffered response release, each stream emission) calls this again; nothing
 * here is cached. Plaintext is decrypted only after the whole decision is
 * `allowed`, and only for the `request` phase.
 */
async function authorizeSubstitute(
  input: {
    substitute: string;
    method: CredentialEgressProxyAuthorize['method'];
    phase: CredentialEgressProxyAuthorize['phase'];
    authorizationId?: string;
  },
  options: {
    /**
     * Current deployment egress policy for the approved origin (public
     * address, HTTPS). Approval-time validation is not enough: policy can
     * tighten after a grant exists, and the proxy's own dial guard is a
     * second line, not the only one.
     */
    isOriginAllowed?: (origin: string) => boolean;
  },
): Promise<CredentialEgressAuthorization> {
  const load = () =>
    db
      .select({
        substitute: credentialEgressSubstitutes,
        workload: credentialEgressWorkloads,
        secret: serviceCredentials,
        session: {
          ownerKind: sessions.ownerKind,
          ownerUserId: sessions.ownerUserId,
          archivedAt: sessions.archivedAt,
        },
        ownerDeletedAt: users.deletedAt,
        ownerMetadata: users.metadata,
        run: { actingUserId: taskRuns.actingUserId, status: taskRuns.status },
        attached: sql<boolean>`exists (
        select 1 from ${sessionTasks}
        where ${sessionTasks.sessionId} = ${credentialEgressWorkloads.sessionId}
          and ${sessionTasks.taskId} = ${taskRuns.taskId}
      )`,
        workloadExpired: sql<boolean>`${credentialEgressWorkloads.expiresAt} <= clock_timestamp()`,
        grantExpired: sql<boolean>`coalesce(${serviceCredentials.expiresAt} <= clock_timestamp(), false)`,
      })
      .from(credentialEgressSubstitutes)
      .innerJoin(
        credentialEgressWorkloads,
        eq(
          credentialEgressWorkloads.id,
          credentialEgressSubstitutes.workloadId,
        ),
      )
      .innerJoin(
        serviceCredentials,
        eq(serviceCredentials.id, credentialEgressSubstitutes.secretId),
      )
      .innerJoin(sessions, eq(sessions.id, credentialEgressWorkloads.sessionId))
      .innerJoin(users, eq(users.id, credentialEgressWorkloads.ownerUserId))
      .innerJoin(taskRuns, eq(taskRuns.id, credentialEgressWorkloads.taskRunId))
      .where(
        eq(
          credentialEgressSubstitutes.tokenHash,
          hashCredentialEgressSubstitute(input.substitute),
        ),
      );

  const decide = (
    row: Awaited<ReturnType<typeof load>>[number] | undefined,
  ): CredentialEgressDenialReason | null => {
    if (!row) return 'unknown_substitute';
    const { substitute, workload, secret, session, run } = row;
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
      session.archivedAt ||
      row.ownerDeletedAt ||
      !isServiceCredentialToolsExperimentEnabled(row.ownerMetadata) ||
      run.actingUserId !== workload.ownerUserId ||
      !ELIGIBLE_RUN_STATUSES.includes(run.status) ||
      !row.attached
    )
      return 'session_unavailable';
    if (!(options.isOriginAllowed?.(secret.origin) ?? true))
      return 'destination_mismatch';
    if (!(secret.allowedMethods as readonly string[]).includes(input.method))
      return 'method_not_allowed';
    return null;
  };

  const [row] = await load();
  const reason = decide(row);
  // An unknown token names no workload, Session, or grant, so there is
  // nothing an audit row could attribute; the caller logs the bounded reason.
  if (!row) return { allowed: false, reason: 'unknown_substitute' };
  const authorizationId = input.authorizationId ?? randomUUID();
  const destination = approvedDestination(row.secret.origin);
  await db.insert(credentialEgressAudit).values({
    authorizationId,
    workloadId: row.workload.id,
    sessionId: row.workload.sessionId,
    actorUserId: row.workload.ownerUserId,
    secretRef: row.secret.id,
    phase: input.phase,
    method: input.method,
    destination: `${destination.host}:${destination.port}`,
    decision: reason ? 'denied' : 'allowed',
    reason,
  });
  if (reason) return { allowed: false, reason };

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
    // Earliest of grant expiry (if any) and workload lease: no exchange outlives either.
    expiresAt: new Date(
      Math.min(
        finalRow.secret.expiresAt?.getTime() ?? Infinity,
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

/** A workload presents a substitute; the token alone names the grant. */
export async function authorizeCredentialEgressProxy(
  input: CredentialEgressProxyAuthorize,
  options: { isOriginAllowed?: (origin: string) => boolean } = {},
): Promise<CredentialEgressAuthorization> {
  return authorizeSubstitute(input, options);
}

/** Audit rows for one workload: bounded codes only, for tests and operator tooling. */
export async function listCredentialEgressAudit(workloadId: string) {
  return db
    .select()
    .from(credentialEgressAudit)
    .where(eq(credentialEgressAudit.workloadId, workloadId))
    .orderBy(asc(credentialEgressAudit.createdAt));
}
