import { and, desc, eq } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { setupQualificationBlocks } from '../schema';

import type {
  SetupQualificationBlockReason,
  SetupQualificationBlockStatus,
} from './setup-qualification';

type SetupQualificationSnapshot = {
  email?: string | null;
  emailDomain?: string | null;
  githubAccountLogin?: string | null;
  githubAccountType?: string | null;
};

type SetupQualificationBlockRow = typeof setupQualificationBlocks.$inferSelect;

function toSnapshotUpdate(
  snapshot: SetupQualificationSnapshot,
): Pick<
  typeof setupQualificationBlocks.$inferInsert,
  'email' | 'emailDomain' | 'githubAccountLogin' | 'githubAccountType'
> {
  return {
    email: snapshot.email ?? null,
    emailDomain: snapshot.emailDomain ?? null,
    githubAccountLogin: snapshot.githubAccountLogin ?? null,
    githubAccountType: snapshot.githubAccountType ?? null,
  };
}

async function findSetupQualificationBlock(params: {
  database: DatabaseOrTransaction;
  userId: string;
  reason: SetupQualificationBlockReason;
}) {
  return params.database.query.setupQualificationBlocks.findFirst({
    where: and(
      eq(setupQualificationBlocks.userId, params.userId),
      eq(setupQualificationBlocks.reason, params.reason),
    ),
  });
}

async function updateSetupQualificationBlockById(params: {
  database: DatabaseOrTransaction;
  id: string;
  status?: SetupQualificationBlockStatus;
  snapshot?: SetupQualificationSnapshot;
  resolvedAt?: Date | null;
  liftedByAdminUserId?: string | null;
  liftedByAdminEmail?: string | null;
  lastBlockedAt?: Date;
}) {
  const now = new Date();
  const [updated] = await params.database
    .update(setupQualificationBlocks)
    .set({
      ...(params.status ? { status: params.status } : {}),
      ...(params.snapshot ? toSnapshotUpdate(params.snapshot) : {}),
      ...(params.resolvedAt !== undefined
        ? { resolvedAt: params.resolvedAt }
        : {}),
      ...(params.liftedByAdminUserId !== undefined
        ? { liftedByAdminUserId: params.liftedByAdminUserId }
        : {}),
      ...(params.liftedByAdminEmail !== undefined
        ? { liftedByAdminEmail: params.liftedByAdminEmail }
        : {}),
      ...(params.lastBlockedAt ? { lastBlockedAt: params.lastBlockedAt } : {}),
      updatedAt: now,
    })
    .where(eq(setupQualificationBlocks.id, params.id))
    .returning();

  return updated ?? null;
}

export async function listSetupQualificationBlocks(params: {
  db?: DatabaseOrTransaction;
}) {
  const database = params.db ?? db;

  return database.query.setupQualificationBlocks.findMany({
    orderBy: [
      desc(setupQualificationBlocks.lastBlockedAt),
      desc(setupQualificationBlocks.createdAt),
    ],
  });
}

export async function getSetupQualificationBlock(params: {
  userId: string;
  reason: SetupQualificationBlockReason;
  db?: DatabaseOrTransaction;
}) {
  const database = params.db ?? db;

  return findSetupQualificationBlock({
    database,
    userId: params.userId,
    reason: params.reason,
  });
}

export async function syncSetupQualificationBlock(params: {
  userId: string;
  reason: SetupQualificationBlockReason;
  blocked: boolean;
  snapshot?: SetupQualificationSnapshot;
  db?: DatabaseOrTransaction;
}) {
  const database = params.db ?? db;
  let existing = await findSetupQualificationBlock({
    database,
    userId: params.userId,
    reason: params.reason,
  });
  const now = new Date();

  if (params.blocked) {
    if (!existing) {
      const [created] = await database
        .insert(setupQualificationBlocks)
        .values({
          userId: params.userId,
          reason: params.reason,
          status: 'blocked',
          ...toSnapshotUpdate(params.snapshot ?? {}),
          firstBlockedAt: now,
          lastBlockedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            setupQualificationBlocks.userId,
            setupQualificationBlocks.reason,
          ],
        })
        .returning();

      if (created) {
        return created;
      }

      existing = await findSetupQualificationBlock({
        database,
        userId: params.userId,
        reason: params.reason,
      });

      if (!existing) {
        throw new Error('Failed to create setup qualification block.');
      }
    }

    if (existing.status === 'lifted') {
      return (
        (await updateSetupQualificationBlockById({
          database,
          id: existing.id,
          snapshot: params.snapshot,
        })) ?? existing
      );
    }

    return (
      (await updateSetupQualificationBlockById({
        database,
        id: existing.id,
        status: 'blocked',
        snapshot: params.snapshot,
        resolvedAt: null,
        liftedByAdminUserId: null,
        liftedByAdminEmail: null,
        lastBlockedAt: now,
      })) ?? existing
    );
  }

  if (!existing || existing.status !== 'blocked') {
    return existing ?? null;
  }

  return (
    (await updateSetupQualificationBlockById({
      database,
      id: existing.id,
      status: 'passed',
      snapshot: params.snapshot,
      resolvedAt: now,
      liftedByAdminUserId: null,
      liftedByAdminEmail: null,
    })) ?? existing
  );
}

export async function liftSetupQualificationBlock(params: {
  userId: string;
  reason: SetupQualificationBlockReason;
  liftedByAdminUserId: string;
  liftedByAdminEmail: string;
  db?: DatabaseOrTransaction;
}): Promise<{
  row: SetupQualificationBlockRow | null;
  changed: boolean;
}> {
  const database = params.db ?? db;
  const existing = await findSetupQualificationBlock({
    database,
    userId: params.userId,
    reason: params.reason,
  });

  if (!existing) {
    return { row: null, changed: false };
  }

  if (existing.status === 'lifted') {
    return { row: existing, changed: false };
  }

  const updated = await updateSetupQualificationBlockById({
    database,
    id: existing.id,
    status: 'lifted',
    resolvedAt: new Date(),
    liftedByAdminUserId: params.liftedByAdminUserId,
    liftedByAdminEmail: params.liftedByAdminEmail,
  });

  return { row: updated ?? existing, changed: true };
}
