import { randomUUID } from 'node:crypto';
import {
  db,
  deploymentSettings,
  environments,
  environmentSnapshots,
  taskRuns,
  tasks,
  eq,
  upsertEnvironmentSnapshot,
  claimPendingEnvironmentSnapshotForAttachment,
  taskFactory,
  resolveDefaultComputeProvider,
} from '@roomote/db/server';
import { computeProviders, RunStatus, TaskPayloadKind } from '@roomote/types';
import { finishRun } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';
import {
  clearEnvironmentSnapshotCommand,
  createEnvironmentSnapshotCommand,
} from './index';

// Real Postgres, real default resolution, and real snapshot cleanup. The web
// server test setup mocks Redis; this suite does not invoke hosted providers.
describe('provider-pinned snapshot operations without an eligible default', () => {
  let environmentId: string;
  let taskId: string | undefined;
  let priorConfig: typeof deploymentSettings.$inferSelect.runtimeComputeConfig;

  beforeEach(async () => {
    priorConfig =
      (
        await db.query.deploymentSettings.findFirst({
          where: eq(deploymentSettings.id, 'default'),
        })
      )?.runtimeComputeConfig ?? null;
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        runtimeComputeConfig: {
          defaultProvider: null,
          excludedProviders: [...computeProviders],
        },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          runtimeComputeConfig: {
            defaultProvider: null,
            excludedProviders: [...computeProviders],
          },
        },
      });
    const [environment] = await db
      .insert(environments)
      .values({
        name: `provider-cleanup-${randomUUID()}`,
        config: { name: 'provider-cleanup', repositories: [] },
      })
      .returning();
    environmentId = environment!.id;
    await expect(resolveDefaultComputeProvider()).rejects.toThrow(
      'No configured sandbox provider is available.',
    );
  });

  afterEach(async () => {
    if (taskId) await db.delete(tasks).where(eq(tasks.id, taskId));
    taskId = undefined;
    await db
      .delete(environmentSnapshots)
      .where(eq(environmentSnapshots.environmentId, environmentId));
    await db.delete(environments).where(eq(environments.id, environmentId));
    await db
      .update(deploymentSettings)
      .set({ runtimeComputeConfig: priorConfig })
      .where(eq(deploymentSettings.id, 'default'));
  });

  it('deletes a retained Modal snapshot without consulting an unused default', async () => {
    await upsertEnvironmentSnapshot(db, {
      environmentId,
      provider: 'modal',
      snapshotId: 'retained-modal',
      snapshotStatus: 'ready',
      snapshotCreatedAt: new Date(),
      snapshotExpiresAt: null,
    });

    expect(
      await clearEnvironmentSnapshotCommand(
        { isAdmin: true } as UserAuthSuccess,
        { environmentId, provider: 'modal' },
      ),
    ).toEqual({ success: true });
    expect(
      await db.query.environmentSnapshots.findMany({
        where: eq(environmentSnapshots.environmentId, environmentId),
      }),
    ).toEqual([]);
  });

  it("fails the canceled run's vendor-pinned pending claim without an eligible default", async () => {
    const claim = await claimPendingEnvironmentSnapshotForAttachment(db, {
      environmentId,
      provider: 'modal',
      updatedAt: new Date(),
    });
    expect(claim).not.toBeNull();
    const task = await taskFactory.create({
      workflow: 'env_snapshot',
      visibility: 'hidden',
    });
    taskId = task.id;
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId,
        vendor: 'modal',
        status: RunStatus.Pending,
        payloadKind: TaskPayloadKind.SnapshotEnvironment,
        payload: {
          repo: '',
          environmentId,
          environmentSnapshotAttachment: claim!.attachmentSource,
        },
      })
      .returning();

    await finishRun({ id: run!.id, status: RunStatus.Canceled });

    expect(
      await db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run!.id) }),
    ).toMatchObject({ status: RunStatus.Canceled });
    expect(
      await db.query.environmentSnapshots.findFirst({
        where: eq(environmentSnapshots.environmentId, environmentId),
      }),
    ).toMatchObject({ snapshotStatus: 'failed', provider: 'modal' });
  });

  it('honors an explicit unsupported provider before trying to create a snapshot', async () => {
    expect(
      await createEnvironmentSnapshotCommand(
        { isAdmin: true } as UserAuthSuccess,
        { environmentId, provider: 'docker' },
      ),
    ).toEqual({
      success: false,
      error: 'Environment snapshots are not supported for docker jobs',
    });
  });

  it('finds an existing explicit Modal snapshot build without an eligible default', async () => {
    const task = await taskFactory.create({
      workflow: 'env_snapshot',
      visibility: 'hidden',
    });
    taskId = task.id;
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId,
        vendor: 'modal',
        status: RunStatus.Running,
        payloadKind: TaskPayloadKind.SnapshotEnvironment,
        payload: { repo: '', environmentId },
      })
      .returning();
    expect(
      await createEnvironmentSnapshotCommand(
        { isAdmin: true } as UserAuthSuccess,
        { environmentId, provider: 'modal' },
      ),
    ).toEqual({ success: true, runId: run!.id, taskId });
  });

  it.each([undefined, 'invalid'] as const)(
    'requires a real default for snapshot commands with provider %s',
    async (provider) => {
      const input = { environmentId, provider } as Parameters<
        typeof clearEnvironmentSnapshotCommand
      >[1];
      expect(
        await clearEnvironmentSnapshotCommand(
          { isAdmin: true } as UserAuthSuccess,
          input,
        ),
      ).toEqual({
        success: false,
        error: 'No configured sandbox provider is available.',
      });
      expect(
        await createEnvironmentSnapshotCommand(
          { isAdmin: true } as UserAuthSuccess,
          input,
        ),
      ).toEqual({
        success: false,
        error: 'No configured sandbox provider is available.',
      });
    },
  );
});
