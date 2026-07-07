import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  environmentSnapshots,
  environments,
  users,
  userFactory,
  environmentFactory,
} from '../../server';

import {
  attachEnvironmentSnapshot,
  claimPendingEnvironmentSnapshot,
  claimPendingEnvironmentSnapshotForAttachment,
  getEnvironmentSnapshot,
  loadEnvironmentSnapshots,
  softDeleteEnvironmentSnapshots,
  upsertEnvironmentSnapshot,
} from '../environment-snapshots';
import { updateEnvironmentDefinition } from '../environment-definitions';

let testUserId: string;
let testEnvironmentId: string;

async function cleanup() {
  if (testEnvironmentId) {
    await db
      .delete(environmentSnapshots)
      .where(eq(environmentSnapshots.environmentId, testEnvironmentId));
    await db.delete(environments).where(eq(environments.id, testEnvironmentId));
  }

  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
}

describe('environment snapshot helpers', () => {
  beforeEach(async () => {
    await cleanup();
    testUserId = randomUUID();
    testEnvironmentId = '';

    await userFactory.create({ id: testUserId });
    const environment = await environmentFactory.create({
      createdByUserId: testUserId,
      snapshotId: 'legacy-sandbox-snapshot',
      snapshotStatus: 'ready',
      snapshotCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      snapshotExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    testEnvironmentId = environment.id;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('claims a pending snapshot at most once while the claim is still fresh', async () => {
    const firstClaimAt = new Date('2026-02-03T00:00:00.000Z');
    const secondClaimAt = new Date('2026-02-03T00:01:00.000Z');

    const firstClaim = await claimPendingEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: firstClaimAt,
    });
    const secondClaim = await claimPendingEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: secondClaimAt,
      allowStalePendingBefore: new Date('2026-02-02T23:59:00.000Z'),
    });

    const snapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(snapshotRow).toEqual(
      expect.objectContaining({
        provider: 'modal',
        snapshotStatus: 'pending',
        updatedAt: firstClaimAt,
      }),
    );
  });

  it('reclaims stale pending snapshot claims when the caller allows recovery', async () => {
    const staleClaimAt = new Date('2026-02-03T00:00:00.000Z');
    const recoveredClaimAt = new Date('2026-02-03T00:10:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: null,
      snapshotStatus: 'pending',
      snapshotCreatedAt: null,
      snapshotExpiresAt: null,
      updatedAt: staleClaimAt,
    });

    const reclaimed = await claimPendingEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: recoveredClaimAt,
      allowStalePendingBefore: new Date('2026-02-03T00:05:00.000Z'),
    });

    const snapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(reclaimed).toBe(true);
    expect(snapshotRow?.updatedAt).toEqual(recoveredClaimAt);
    expect(snapshotRow?.snapshotStatus).toBe('pending');
  });

  it('atomically lets only one concurrent pending claim win', async () => {
    const claimAt = new Date('2026-02-03T00:00:00.000Z');

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimPendingEnvironmentSnapshot(db, {
          environmentId: testEnvironmentId,
          provider: 'modal',
          updatedAt: claimAt,
        }),
      ),
    );

    const snapshotRows = await db.query.environmentSnapshots.findMany({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows[0]).toEqual(
      expect.objectContaining({
        provider: 'modal',
        snapshotStatus: 'pending',
      }),
    );
  });

  it('keeps a newly ready snapshot intact when the caller requires a missing snapshot', async () => {
    const readyAt = new Date('2026-02-03T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'snap-ready',
      snapshotStatus: 'ready',
      snapshotCreatedAt: readyAt,
      snapshotExpiresAt: new Date('2026-02-04T00:00:00.000Z'),
      updatedAt: readyAt,
    });

    const claimed = await claimPendingEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: new Date('2026-02-03T00:01:00.000Z'),
      requireMissingSnapshot: true,
    });

    const snapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(claimed).toBe(false);
    expect(snapshotRow).toEqual(
      expect.objectContaining({
        provider: 'modal',
        snapshotId: 'snap-ready',
        snapshotStatus: 'ready',
      }),
    );
  });

  it('attaches completed manual snapshots only through an active pending row', async () => {
    const now = new Date('2026-02-03T00:00:00.000Z');
    const expiresAt = new Date('2026-02-04T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: null,
      snapshotStatus: 'pending',
      snapshotCreatedAt: null,
      snapshotExpiresAt: null,
    });

    const attached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-ready',
      snapshotStatus: 'ready',
      snapshotCreatedAt: now,
      snapshotExpiresAt: expiresAt,
    });

    expect(attached).toBe(true);

    await softDeleteEnvironmentSnapshots(db, {
      environmentId: testEnvironmentId,
      updatedAt: now,
      deletedAt: now,
    });

    const staleAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-stale',
      snapshotStatus: 'ready',
      snapshotCreatedAt: now,
      snapshotExpiresAt: expiresAt,
    });

    const activeSnapshot = await getEnvironmentSnapshot({
      environmentId: testEnvironmentId,
      provider: 'modal',
    });

    expect(staleAttached).toBe(false);
    expect(activeSnapshot).toBeUndefined();
  });

  it('rejects stale pending-row attachments after invalidation and a newer claim', async () => {
    const firstClaimAt = new Date('2026-02-03T00:00:00.000Z');
    const invalidatedAt = new Date('2026-02-03T00:01:00.000Z');
    const secondClaimAt = new Date('2026-02-03T00:02:00.000Z');
    const completedAt = new Date('2026-02-03T00:03:00.000Z');
    const expiresAt = new Date('2026-02-04T00:00:00.000Z');

    const firstClaim = await claimPendingEnvironmentSnapshotForAttachment(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: firstClaimAt,
    });

    await softDeleteEnvironmentSnapshots(db, {
      environmentId: testEnvironmentId,
      updatedAt: invalidatedAt,
      deletedAt: invalidatedAt,
    });

    const secondClaim = await claimPendingEnvironmentSnapshotForAttachment(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: secondClaimAt,
    });

    const staleAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-stale',
      snapshotStatus: 'ready',
      snapshotCreatedAt: completedAt,
      snapshotExpiresAt: expiresAt,
      attachmentSource: firstClaim!.attachmentSource,
    });
    const currentAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-current',
      snapshotStatus: 'ready',
      snapshotCreatedAt: completedAt,
      snapshotExpiresAt: expiresAt,
      attachmentSource: secondClaim!.attachmentSource,
    });

    const snapshotRows = await db.query.environmentSnapshots.findMany({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });
    const currentSnapshotRow = snapshotRows.find(
      (row) => row.deletedAt === null,
    );

    expect(firstClaim).toEqual(
      expect.objectContaining({
        environmentSnapshotId: expect.any(String),
        claimedAt: firstClaimAt,
      }),
    );
    expect(secondClaim).toEqual(
      expect.objectContaining({
        environmentSnapshotId: expect.any(String),
        claimedAt: secondClaimAt,
      }),
    );
    expect(staleAttached).toBe(false);
    expect(currentAttached).toBe(true);
    expect(currentSnapshotRow).toEqual(
      expect.objectContaining({
        id: secondClaim!.environmentSnapshotId,
        snapshotId: 'sandbox-snapshot-current',
        snapshotStatus: 'ready',
        snapshotCreatedAt: completedAt,
      }),
    );
  });

  it('rejects identity-free pending attachments when the pending claim is newer than the job', async () => {
    const staleJobCreatedAt = new Date('2026-02-03T00:00:00.000Z');
    const newerClaimAt = new Date('2026-02-03T00:02:00.000Z');
    const completedAt = new Date('2026-02-03T00:03:00.000Z');
    const expiresAt = new Date('2026-02-04T00:00:00.000Z');

    await claimPendingEnvironmentSnapshotForAttachment(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      updatedAt: newerClaimAt,
    });

    const staleAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'modal-snapshot-stale',
      snapshotStatus: 'ready',
      snapshotCreatedAt: completedAt,
      snapshotExpiresAt: expiresAt,
      maxPendingUpdatedAt: staleJobCreatedAt,
    });

    const currentSnapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(staleAttached).toBe(false);
    expect(currentSnapshotRow).toEqual(
      expect.objectContaining({
        provider: 'modal',
        snapshotId: null,
        snapshotStatus: 'pending',
        updatedAt: newerClaimAt,
      }),
    );
  });

  it('attaches refresh snapshots only to the active source row', async () => {
    const now = new Date('2026-02-03T00:00:00.000Z');
    const expiresAt = new Date('2026-02-04T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-old',
      snapshotStatus: 'ready',
      snapshotCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
      snapshotExpiresAt: new Date('2026-02-02T00:00:00.000Z'),
    });

    const snapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    const attached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-refreshed',
      snapshotStatus: 'ready',
      snapshotCreatedAt: now,
      snapshotExpiresAt: expiresAt,
      attachmentSource: {
        source: 'active_snapshot_row',
        environmentSnapshotId: snapshotRow!.id,
        sourceSnapshotId: snapshotRow!.snapshotId,
        sourceSnapshotCreatedAt:
          snapshotRow!.snapshotCreatedAt?.toISOString() ?? null,
      },
    });

    expect(attached).toBe(true);

    await softDeleteEnvironmentSnapshots(db, {
      environmentId: testEnvironmentId,
      updatedAt: now,
      deletedAt: now,
    });

    const staleAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-stale-refresh',
      snapshotStatus: 'ready',
      snapshotCreatedAt: now,
      snapshotExpiresAt: expiresAt,
      attachmentSource: {
        source: 'active_snapshot_row',
        environmentSnapshotId: snapshotRow!.id,
        sourceSnapshotId: snapshotRow!.snapshotId,
        sourceSnapshotCreatedAt:
          snapshotRow!.snapshotCreatedAt?.toISOString() ?? null,
      },
    });

    expect(staleAttached).toBe(false);
  });

  it('does not attach legacy row-id-only refresh payloads', async () => {
    const sourceCreatedAt = new Date('2026-02-01T00:00:00.000Z');
    const sourceExpiresAt = new Date('2026-02-02T00:00:00.000Z');
    const refreshCreatedAt = new Date('2026-02-03T00:00:00.000Z');
    const refreshExpiresAt = new Date('2026-02-04T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-old',
      snapshotStatus: 'ready',
      snapshotCreatedAt: sourceCreatedAt,
      snapshotExpiresAt: sourceExpiresAt,
    });

    const sourceSnapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    const attached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-legacy-refresh',
      snapshotStatus: 'ready',
      snapshotCreatedAt: refreshCreatedAt,
      snapshotExpiresAt: refreshExpiresAt,
      attachmentSource: {
        source: 'legacy_active_snapshot_row',
        environmentSnapshotId: sourceSnapshotRow!.id,
      },
    });

    const currentSnapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(attached).toBe(false);
    expect(currentSnapshotRow).toEqual(
      expect.objectContaining({
        id: sourceSnapshotRow!.id,
        snapshotId: 'sandbox-snapshot-old',
        snapshotStatus: 'ready',
        snapshotCreatedAt: sourceCreatedAt,
        snapshotExpiresAt: sourceExpiresAt,
      }),
    );
  });

  it('does not soft delete snapshots for an unchanged environment definition', async () => {
    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-123',
      snapshotStatus: 'ready',
      snapshotCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
      snapshotExpiresAt: new Date('2026-02-02T00:00:00.000Z'),
    });

    const environmentBefore = await db.query.environments.findFirst({
      where: eq(environments.id, testEnvironmentId),
    });

    const result = await updateEnvironmentDefinition(db, {
      environmentId: testEnvironmentId,
      fields: {
        name: environmentBefore!.name,
        description: environmentBefore!.description,
        config: environmentBefore!.config,
      },
    });

    const snapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(result).toEqual({
      updated: false,
      snapshotsInvalidated: false,
    });
    expect(snapshotRow).toEqual(
      expect.objectContaining({
        snapshotId: 'sandbox-snapshot-123',
        deletedAt: null,
      }),
    );
  });

  it('rejects stale refresh attachments after the active row is reused by a manual snapshot', async () => {
    const sourceCreatedAt = new Date('2026-02-01T00:00:00.000Z');
    const sourceExpiresAt = new Date('2026-02-02T00:00:00.000Z');
    const manualCreatedAt = new Date('2026-02-03T00:00:00.000Z');
    const manualExpiresAt = new Date('2026-02-04T00:00:00.000Z');
    const refreshCreatedAt = new Date('2026-02-05T00:00:00.000Z');
    const refreshExpiresAt = new Date('2026-02-06T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-old',
      snapshotStatus: 'ready',
      snapshotCreatedAt: sourceCreatedAt,
      snapshotExpiresAt: sourceExpiresAt,
    });

    const sourceSnapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: null,
      snapshotStatus: 'pending',
      snapshotCreatedAt: null,
      snapshotExpiresAt: null,
    });

    const manualAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-manual',
      snapshotStatus: 'ready',
      snapshotCreatedAt: manualCreatedAt,
      snapshotExpiresAt: manualExpiresAt,
    });

    const staleRefreshAttached = await attachEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-stale-refresh',
      snapshotStatus: 'ready',
      snapshotCreatedAt: refreshCreatedAt,
      snapshotExpiresAt: refreshExpiresAt,
      attachmentSource: {
        source: 'active_snapshot_row',
        environmentSnapshotId: sourceSnapshotRow!.id,
        sourceSnapshotId: sourceSnapshotRow!.snapshotId,
        sourceSnapshotCreatedAt:
          sourceSnapshotRow!.snapshotCreatedAt?.toISOString() ?? null,
      },
    });

    const currentSnapshotRow = await db.query.environmentSnapshots.findFirst({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(manualAttached).toBe(true);
    expect(staleRefreshAttached).toBe(false);
    expect(currentSnapshotRow).toEqual(
      expect.objectContaining({
        id: sourceSnapshotRow!.id,
        snapshotId: 'sandbox-snapshot-manual',
        snapshotStatus: 'ready',
        snapshotCreatedAt: manualCreatedAt,
        snapshotExpiresAt: manualExpiresAt,
      }),
    );
  });

  it('excludes soft-deleted snapshots from active lookups until a new snapshot is written', async () => {
    const deletedAt = new Date('2026-02-03T00:00:00.000Z');
    const restoredExpiresAt = new Date('2026-02-05T00:00:00.000Z');

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-123',
      snapshotStatus: 'ready',
      snapshotCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
      snapshotExpiresAt: new Date('2026-02-02T00:00:00.000Z'),
    });

    await softDeleteEnvironmentSnapshots(db, {
      environmentId: testEnvironmentId,
      deletedAt,
      updatedAt: deletedAt,
    });

    const activeSnapshot = await getEnvironmentSnapshot({
      environmentId: testEnvironmentId,
      provider: 'modal',
    });
    const activeSnapshots = await loadEnvironmentSnapshots([
      { id: testEnvironmentId },
    ]);

    expect(activeSnapshot).toBeUndefined();
    expect(activeSnapshots.get(testEnvironmentId)?.modal).toBeUndefined();

    await upsertEnvironmentSnapshot(db, {
      environmentId: testEnvironmentId,
      provider: 'modal',
      snapshotId: 'sandbox-snapshot-456',
      snapshotStatus: 'ready',
      snapshotCreatedAt: deletedAt,
      snapshotExpiresAt: restoredExpiresAt,
      updatedAt: deletedAt,
    });

    const restoredSnapshot = await getEnvironmentSnapshot({
      environmentId: testEnvironmentId,
      provider: 'modal',
    });
    const snapshotRows = await db.query.environmentSnapshots.findMany({
      where: eq(environmentSnapshots.environmentId, testEnvironmentId),
    });

    expect(restoredSnapshot).toEqual(
      expect.objectContaining({
        snapshotId: 'sandbox-snapshot-456',
      }),
    );
    expect(snapshotRows).toHaveLength(2);
    expect(snapshotRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshotId: 'sandbox-snapshot-123',
          deletedAt,
        }),
        expect.objectContaining({
          snapshotId: 'sandbox-snapshot-456',
          deletedAt: null,
        }),
      ]),
    );
  });
});
