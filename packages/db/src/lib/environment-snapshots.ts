import type {
  ComputeProvider,
  SnapshotEnvironmentAttachment,
} from '@roomote/types';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { db, type DatabaseOrTransaction } from '../db';
import { environmentSnapshots, environments } from '../schema';
import type { Run } from '../types';
import { runInTransactionIfAvailable } from './transaction-utils';

export type EnvironmentSnapshotStatus =
  | 'pending'
  | 'ready'
  | 'expired'
  | 'failed';

export interface EnvironmentSnapshotRecord {
  provider: ComputeProvider;
  snapshotId: string | null;
  snapshotStatus: EnvironmentSnapshotStatus | null;
  snapshotCreatedAt: Date | null;
  snapshotExpiresAt: Date | null;
}

export interface EnvironmentSnapshotMutationInput {
  environmentId: string;
  provider: ComputeProvider;
  snapshotId: string | null;
  snapshotStatus: EnvironmentSnapshotStatus | null;
  snapshotCreatedAt: Date | null;
  snapshotExpiresAt: Date | null;
  updatedAt?: Date;
}

export interface ClaimPendingEnvironmentSnapshotInput {
  environmentId: string;
  provider: ComputeProvider;
  updatedAt?: Date;
  allowStalePendingBefore?: Date;
  requireMissingSnapshot?: boolean;
}

export interface EnvironmentSnapshotLockInput {
  environmentId: string;
  provider: ComputeProvider;
}
export type EnvironmentSnapshotAttachmentSource = SnapshotEnvironmentAttachment;
type PendingEnvironmentSnapshotAttachmentSource = Extract<
  EnvironmentSnapshotAttachmentSource,
  { source: 'pending_snapshot_row' }
>;

export interface PendingEnvironmentSnapshotClaim {
  environmentSnapshotId: string;
  claimedAt: Date;
  attachmentSource: PendingEnvironmentSnapshotAttachmentSource;
}

export interface PendingEnvironmentSnapshotMatch {
  attachmentSource: EnvironmentSnapshotAttachmentSource | null;
  maxPendingUpdatedAt: Date | null;
}

interface PendingEnvironmentSnapshotMatchInput {
  attachmentSource?: EnvironmentSnapshotAttachmentSource | null;
  maxPendingUpdatedAt?: Date | null;
}

function hasReadySnapshotState(
  snapshotId: string | null | undefined,
  snapshotStatus: EnvironmentSnapshotStatus | null | undefined,
): boolean {
  return snapshotId != null && snapshotStatus === 'ready';
}

function getPendingSnapshotAttachmentSource(
  params: PendingEnvironmentSnapshotMatchInput,
): PendingEnvironmentSnapshotAttachmentSource | null {
  return params.attachmentSource?.source === 'pending_snapshot_row'
    ? params.attachmentSource
    : null;
}

export function getEnvironmentSnapshotAttachmentSourceForCloudJob(
  cloudJob: Pick<Run, 'payload'>,
): EnvironmentSnapshotAttachmentSource | null {
  return 'environmentSnapshotAttachment' in cloudJob.payload
    ? (cloudJob.payload.environmentSnapshotAttachment ?? null)
    : null;
}

export function buildPendingEnvironmentSnapshotMatchForCloudJob(
  cloudJob: Pick<Run, 'payload' | 'createdAt'>,
): PendingEnvironmentSnapshotMatch {
  const attachmentSource =
    getEnvironmentSnapshotAttachmentSourceForCloudJob(cloudJob);

  if (attachmentSource?.source === 'pending_snapshot_row') {
    return { attachmentSource, maxPendingUpdatedAt: null };
  }

  return {
    attachmentSource: null,
    maxPendingUpdatedAt: cloudJob.createdAt ?? null,
  };
}

async function lockEnvironmentForSnapshotMutation(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<void> {
  await dbOrTx
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .for('update');
}

async function runEnvironmentSnapshotMutation<T>(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
  mutation: (tx: DatabaseOrTransaction) => Promise<T>,
): Promise<T> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    await lockEnvironmentForSnapshotMutation(tx, environmentId);
    return mutation(tx);
  });
}

export async function loadEnvironmentSnapshots(
  environmentRefs: Array<{ id: string }>,
): Promise<
  Map<string, Partial<Record<ComputeProvider, EnvironmentSnapshotRecord>>>
> {
  const environmentIds = environmentRefs.map(({ id }) => id);
  const snapshotsByEnvironment = new Map<
    string,
    Partial<Record<ComputeProvider, EnvironmentSnapshotRecord>>
  >();

  if (environmentIds.length > 0) {
    const snapshotRows = await db.query.environmentSnapshots.findMany({
      where: and(
        inArray(environmentSnapshots.environmentId, environmentIds),
        isNull(environmentSnapshots.deletedAt),
      ),
      columns: {
        environmentId: true,
        provider: true,
        snapshotId: true,
        snapshotStatus: true,
        snapshotCreatedAt: true,
        snapshotExpiresAt: true,
      },
    });

    for (const snapshot of snapshotRows) {
      const current =
        snapshotsByEnvironment.get(snapshot.environmentId) ??
        Object.create(null);
      current[snapshot.provider] = {
        provider: snapshot.provider,
        snapshotId: snapshot.snapshotId,
        snapshotStatus: snapshot.snapshotStatus,
        snapshotCreatedAt: snapshot.snapshotCreatedAt,
        snapshotExpiresAt: snapshot.snapshotExpiresAt,
      };
      snapshotsByEnvironment.set(snapshot.environmentId, current);
    }
  }

  return snapshotsByEnvironment;
}

export async function getEnvironmentSnapshot(params: {
  environmentId: string;
  provider: ComputeProvider;
}): Promise<EnvironmentSnapshotRecord | undefined> {
  const snapshot = await db.query.environmentSnapshots.findFirst({
    where: and(
      eq(environmentSnapshots.environmentId, params.environmentId),
      eq(environmentSnapshots.provider, params.provider),
      isNull(environmentSnapshots.deletedAt),
    ),
    columns: {
      provider: true,
      snapshotId: true,
      snapshotStatus: true,
      snapshotCreatedAt: true,
      snapshotExpiresAt: true,
    },
  });

  if (snapshot) {
    return {
      provider: snapshot.provider,
      snapshotId: snapshot.snapshotId,
      snapshotStatus: snapshot.snapshotStatus,
      snapshotCreatedAt: snapshot.snapshotCreatedAt,
      snapshotExpiresAt: snapshot.snapshotExpiresAt,
    };
  }

  return undefined;
}

export async function upsertEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput,
): Promise<void> {
  return runEnvironmentSnapshotMutation(dbOrTx, params.environmentId, (tx) =>
    upsertEnvironmentSnapshotLocked(tx, params),
  );
}

async function upsertEnvironmentSnapshotLocked(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput,
): Promise<void> {
  const now = params.updatedAt ?? new Date();

  const insertedRows = await dbOrTx
    .insert(environmentSnapshots)
    .values({
      environmentId: params.environmentId,
      provider: params.provider,
      snapshotId: params.snapshotId,
      snapshotStatus: params.snapshotStatus,
      snapshotCreatedAt: params.snapshotCreatedAt,
      snapshotExpiresAt: params.snapshotExpiresAt,
      deletedAt: null,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        environmentSnapshots.environmentId,
        environmentSnapshots.provider,
      ],
      where: sql`${environmentSnapshots.deletedAt} IS NULL`,
    })
    .returning({ id: environmentSnapshots.id });

  if (insertedRows.length === 0) {
    await dbOrTx
      .update(environmentSnapshots)
      .set({
        snapshotId: params.snapshotId,
        snapshotStatus: params.snapshotStatus,
        snapshotCreatedAt: params.snapshotCreatedAt,
        snapshotExpiresAt: params.snapshotExpiresAt,
        deletedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(environmentSnapshots.environmentId, params.environmentId),
          eq(environmentSnapshots.provider, params.provider),
          isNull(environmentSnapshots.deletedAt),
        ),
      );
  }
}

export async function withEnvironmentSnapshotLock<T>(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotLockInput,
  callback: (tx: DatabaseOrTransaction) => Promise<T>,
): Promise<T> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`environment-snapshot:${params.environmentId}:${params.provider}`}))`,
    );

    return callback(tx);
  });
}

export async function claimPendingEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: ClaimPendingEnvironmentSnapshotInput,
): Promise<boolean> {
  return (
    (await claimPendingEnvironmentSnapshotForAttachment(dbOrTx, params)) !==
    null
  );
}

export async function claimPendingEnvironmentSnapshotForAttachment(
  dbOrTx: DatabaseOrTransaction,
  params: ClaimPendingEnvironmentSnapshotInput,
): Promise<PendingEnvironmentSnapshotClaim | null> {
  const now = params.updatedAt ?? new Date();
  const allowStalePendingBefore = params.allowStalePendingBefore;

  const hasBlockingPendingClaim = (
    snapshotStatus: EnvironmentSnapshotStatus | null | undefined,
    updatedAt: Date | null | undefined,
  ): boolean => {
    if (snapshotStatus !== 'pending') {
      return false;
    }

    if (!allowStalePendingBefore) {
      return true;
    }

    return updatedAt == null || updatedAt >= allowStalePendingBefore;
  };

  return withEnvironmentSnapshotLock(dbOrTx, params, async (tx) => {
    const existingSnapshot = await tx.query.environmentSnapshots.findFirst({
      where: and(
        eq(environmentSnapshots.environmentId, params.environmentId),
        eq(environmentSnapshots.provider, params.provider),
        isNull(environmentSnapshots.deletedAt),
      ),
      columns: {
        snapshotId: true,
        snapshotStatus: true,
        updatedAt: true,
      },
    });

    if (
      params.requireMissingSnapshot &&
      hasReadySnapshotState(
        existingSnapshot?.snapshotId,
        existingSnapshot?.snapshotStatus,
      )
    ) {
      return null;
    }

    if (
      hasBlockingPendingClaim(
        existingSnapshot?.snapshotStatus,
        existingSnapshot?.updatedAt,
      )
    ) {
      return null;
    }

    await upsertEnvironmentSnapshot(tx, {
      environmentId: params.environmentId,
      provider: params.provider,
      snapshotId: null,
      snapshotStatus: 'pending',
      snapshotCreatedAt: null,
      snapshotExpiresAt: null,
      updatedAt: now,
    });

    const claimedSnapshot = await tx.query.environmentSnapshots.findFirst({
      where: and(
        eq(environmentSnapshots.environmentId, params.environmentId),
        eq(environmentSnapshots.provider, params.provider),
        isNull(environmentSnapshots.deletedAt),
      ),
      columns: {
        id: true,
        updatedAt: true,
      },
    });

    if (!claimedSnapshot) {
      throw new Error('Failed to claim pending environment snapshot row');
    }

    return {
      environmentSnapshotId: claimedSnapshot.id,
      claimedAt: claimedSnapshot.updatedAt,
      attachmentSource: {
        source: 'pending_snapshot_row',
        environmentSnapshotId: claimedSnapshot.id,
        claimedAt: claimedSnapshot.updatedAt.toISOString(),
      },
    };
  });
}

export async function clearEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: {
    environmentId: string;
    provider: ComputeProvider;
    updatedAt?: Date;
  },
): Promise<void> {
  return runEnvironmentSnapshotMutation(dbOrTx, params.environmentId, (tx) =>
    clearEnvironmentSnapshotLocked(tx, params),
  );
}

async function clearEnvironmentSnapshotLocked(
  dbOrTx: DatabaseOrTransaction,
  params: {
    environmentId: string;
    provider: ComputeProvider;
    updatedAt?: Date;
  },
): Promise<void> {
  await dbOrTx
    .delete(environmentSnapshots)
    .where(
      and(
        eq(environmentSnapshots.environmentId, params.environmentId),
        eq(environmentSnapshots.provider, params.provider),
      ),
    );
}

async function updateActiveEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput & {
    environmentSnapshotId: string;
    sourceSnapshotId: string | null;
    sourceSnapshotCreatedAt: string | null;
  },
): Promise<boolean> {
  const now = params.updatedAt ?? new Date();

  const sourceSnapshotCreatedAt =
    params.sourceSnapshotCreatedAt === null
      ? null
      : new Date(params.sourceSnapshotCreatedAt);

  const updatedRows = await dbOrTx
    .update(environmentSnapshots)
    .set({
      snapshotId: params.snapshotId,
      snapshotStatus: params.snapshotStatus,
      snapshotCreatedAt: params.snapshotCreatedAt,
      snapshotExpiresAt: params.snapshotExpiresAt,
      deletedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentSnapshots.id, params.environmentSnapshotId),
        eq(environmentSnapshots.environmentId, params.environmentId),
        eq(environmentSnapshots.provider, params.provider),
        params.sourceSnapshotId === null
          ? isNull(environmentSnapshots.snapshotId)
          : eq(environmentSnapshots.snapshotId, params.sourceSnapshotId),
        sourceSnapshotCreatedAt === null
          ? isNull(environmentSnapshots.snapshotCreatedAt)
          : eq(environmentSnapshots.snapshotCreatedAt, sourceSnapshotCreatedAt),
        isNull(environmentSnapshots.deletedAt),
      ),
    )
    .returning({ id: environmentSnapshots.id });

  if (updatedRows.length === 0) {
    return false;
  }

  return true;
}

export async function attachEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput & {
    attachmentSource?: EnvironmentSnapshotAttachmentSource | null;
    maxPendingUpdatedAt?: Date | null;
  },
): Promise<boolean> {
  return runEnvironmentSnapshotMutation(dbOrTx, params.environmentId, (tx) =>
    attachEnvironmentSnapshotLocked(tx, params),
  );
}

async function attachEnvironmentSnapshotLocked(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput & {
    attachmentSource?: EnvironmentSnapshotAttachmentSource | null;
    maxPendingUpdatedAt?: Date | null;
  },
): Promise<boolean> {
  if (params.attachmentSource?.source === 'active_snapshot_row') {
    return updateActiveEnvironmentSnapshot(dbOrTx, {
      ...params,
      environmentSnapshotId: params.attachmentSource.environmentSnapshotId,
      sourceSnapshotId: params.attachmentSource.sourceSnapshotId,
      sourceSnapshotCreatedAt: params.attachmentSource.sourceSnapshotCreatedAt,
    });
  }

  if (params.attachmentSource?.source === 'legacy_active_snapshot_row') {
    return false;
  }

  // legacy_sandbox_row attachments predate the environment_snapshots table
  // (and the removed Vercel Sandbox provider); they are no longer
  // re-attachable.
  if (params.attachmentSource?.source === 'legacy_sandbox_row') {
    return false;
  }

  return updatePendingEnvironmentSnapshotLocked(dbOrTx, params);
}

export async function softDeleteEnvironmentSnapshots(
  dbOrTx: DatabaseOrTransaction,
  params: {
    environmentId: string;
    updatedAt?: Date;
    deletedAt?: Date;
  },
): Promise<void> {
  return runEnvironmentSnapshotMutation(dbOrTx, params.environmentId, (tx) =>
    softDeleteEnvironmentSnapshotsLocked(tx, params),
  );
}

async function softDeleteEnvironmentSnapshotsLocked(
  dbOrTx: DatabaseOrTransaction,
  params: {
    environmentId: string;
    updatedAt?: Date;
    deletedAt?: Date;
  },
): Promise<void> {
  const now = params.updatedAt ?? new Date();
  const deletedAt = params.deletedAt ?? now;

  await dbOrTx
    .update(environmentSnapshots)
    .set({
      deletedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentSnapshots.environmentId, params.environmentId),
        isNull(environmentSnapshots.deletedAt),
      ),
    );
}

export async function updatePendingEnvironmentSnapshot(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput & {
    attachmentSource?: EnvironmentSnapshotAttachmentSource | null;
    maxPendingUpdatedAt?: Date | null;
  },
): Promise<boolean> {
  return runEnvironmentSnapshotMutation(dbOrTx, params.environmentId, (tx) =>
    updatePendingEnvironmentSnapshotLocked(tx, params),
  );
}

async function updatePendingEnvironmentSnapshotLocked(
  dbOrTx: DatabaseOrTransaction,
  params: EnvironmentSnapshotMutationInput & {
    attachmentSource?: EnvironmentSnapshotAttachmentSource | null;
    maxPendingUpdatedAt?: Date | null;
  },
): Promise<boolean> {
  const now = params.updatedAt ?? new Date();
  const pendingAttachmentSource = getPendingSnapshotAttachmentSource(params);
  const pendingClaimedAt = pendingAttachmentSource
    ? new Date(pendingAttachmentSource.claimedAt)
    : null;
  const maxPendingUpdatedAt =
    pendingAttachmentSource === null
      ? (params.maxPendingUpdatedAt ?? null)
      : null;

  const updatedRows = await dbOrTx
    .update(environmentSnapshots)
    .set({
      snapshotId: params.snapshotId,
      snapshotStatus: params.snapshotStatus,
      snapshotCreatedAt: params.snapshotCreatedAt,
      snapshotExpiresAt: params.snapshotExpiresAt,
      deletedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentSnapshots.environmentId, params.environmentId),
        eq(environmentSnapshots.provider, params.provider),
        ...(pendingAttachmentSource
          ? [
              eq(
                environmentSnapshots.id,
                pendingAttachmentSource.environmentSnapshotId,
              ),
              eq(environmentSnapshots.updatedAt, pendingClaimedAt!),
            ]
          : []),
        ...(maxPendingUpdatedAt
          ? [lte(environmentSnapshots.updatedAt, maxPendingUpdatedAt)]
          : []),
        eq(environmentSnapshots.snapshotStatus, 'pending'),
        isNull(environmentSnapshots.deletedAt),
      ),
    )
    .returning({ id: environmentSnapshots.id });

  return updatedRows.length > 0;
}
