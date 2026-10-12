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
  withoutEligibleComputeDefault,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';
import { finishRun } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';
import {
  clearEnvironmentSnapshotCommand,
  createEnvironmentSnapshotCommand,
} from './index';

const fixture = vi.hoisted(() => ({
  executor: undefined as DatabaseOrTransaction | undefined,
}));
vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...actual,
    // Only default resolution needs the singleton fixture. Snapshot helpers,
    // factories and finishRun's other persistence keep their real DB ownership.
    resolveDefaultComputeProvider: () => {
      if (!fixture.executor) throw new Error('Missing compute-default fixture');
      return actual.resolveDefaultComputeProvider({
        executor: fixture.executor,
      });
    },
  };
});

test('rolls back successful and failed no-default fixtures without exposing settings to other connections', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  const readSettings = () =>
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { runtimeComputeConfig: true },
    });
  const before = await readSettings();
  const failure = new Error('Deliberately failing fixture callback');
  await expect(
    withoutEligibleComputeDefault(async (executor) => {
      await expect(
        actual.resolveDefaultComputeProvider({ executor }),
      ).rejects.toThrow('No configured sandbox provider is available.');
      expect(await readSettings()).toEqual(before);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await readSettings()).toEqual(before);
  await expect(
    withoutEligibleComputeDefault(async (executor) => {
      await expect(
        actual.resolveDefaultComputeProvider({ executor }),
      ).rejects.toThrow('No configured sandbox provider is available.');
      return 'fixture result';
    }),
  ).resolves.toBe('fixture result');
  expect(await readSettings()).toEqual(before);
});

const it = test.extend<{ computeDefault: void }>({
  computeDefault: [
    // Vitest requires destructuring to discover fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await withoutEligibleComputeDefault(async (executor) => {
        fixture.executor = executor;
        try {
          await use();
        } finally {
          fixture.executor = undefined;
        }
      });
    },
    { auto: true },
  ],
});

// Real Postgres, real default resolution, and real snapshot cleanup. The web
// server test setup mocks Redis; this suite does not invoke hosted providers.
describe('provider-pinned snapshot operations without an eligible default', () => {
  let environmentId: string;
  let taskId: string | undefined;

  beforeEach(async () => {
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
