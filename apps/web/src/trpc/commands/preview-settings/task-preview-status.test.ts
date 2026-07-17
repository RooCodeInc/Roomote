import {
  db,
  environmentFactory,
  runFactory,
  taskFactory,
  taskRuns,
  eq,
} from '@roomote/db/server';
import {
  ENVIRONMENT_PREVIEW_REPAIR_CHANGE_REQUEST,
  ENVIRONMENT_PREVIEW_SETUP_CHANGE_REQUEST,
  RunStatus,
} from '@roomote/types';
import { enqueueTask } from '@roomote/cloud-agents/server';

import type { UserAuthSuccess } from '@/types';

import {
  getTaskPreviewStatusCommand,
  startPreviewSetupTaskCommand,
} from './index';

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(() => {
    throw new Error('enqueueTask should not be called in these tests');
  }),
}));

const auth = { userId: 'test-user', isAdmin: false } as UserAuthSuccess;
const adminAuth = { userId: 'test-admin', isAdmin: true } as UserAuthSuccess;

async function createEnvironmentBackedTask(params: {
  environmentId: string;
  machineDomains?: Record<string, string>;
}) {
  const task = await taskFactory.create({ workflow: 'standard' });
  const run = await runFactory.create({
    taskId: task.id,
    payload: {
      repo: 'test/repo',
      environmentId: params.environmentId,
      description: 'work',
    } as never,
  });

  if (params.machineDomains) {
    await db
      .update(taskRuns)
      .set({ machineDomains: params.machineDomains })
      .where(eq(taskRuns.id, run.id));
  }

  return task;
}

async function createActiveSetupTask(environmentId: string) {
  const task = await taskFactory.create({ workflow: 'setup_onboarding' });
  const run = await runFactory.create({
    taskId: task.id,
    payload: {
      repo: 'test/repo',
      environmentDefinitionId: environmentId,
      description: 'setup',
    } as never,
  });
  await db
    .update(taskRuns)
    .set({ status: RunStatus.Running })
    .where(eq(taskRuns.id, run.id));
  return task;
}

describe('getTaskPreviewStatusCommand', () => {
  it('returns a null environment for repo-only tasks', async () => {
    const task = await taskFactory.create({ workflow: 'standard' });
    await runFactory.create({
      taskId: task.id,
      payload: { repo: 'test/repo', description: 'work' } as never,
    });

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.environment).toBeNull();
    expect(status.runHasPreviewDomains).toBe(false);
    expect(status.setupTask).toBeNull();
  });

  it('reports configured ports and their names for environment-backed tasks', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: {
        name: 'Env',
        repositories: [{ repository: 'test/repo' }],
        ports: [{ name: 'WEB', port: 3000, primary: true }],
      } as never,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.environment).toMatchObject({
      id: environment.id,
      hasConfiguredPorts: true,
      portNames: ['WEB'],
    });
  });

  it('reports missing ports without leaking environment config', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.environment?.hasConfiguredPorts).toBe(false);
    expect(status.environment?.portNames).toEqual([]);
    expect(status.environment).not.toHaveProperty('config');
  });

  it('ignores internal-only machine domains when reporting preview domains', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
      machineDomains: { SANDBOX_SERVER: 'internal.example.com' },
    });

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.runHasPreviewDomains).toBe(false);
  });

  it('reports preview domains when the run exposes a user-facing port', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
      machineDomains: {
        SANDBOX_SERVER: 'internal.example.com',
        WEB: 'task-web.preview.example.com',
      },
    });

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.runHasPreviewDomains).toBe(true);
  });

  it('surfaces an active setup task for the environment', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });
    const setupTask = await createActiveSetupTask(environment.id);

    const status = await getTaskPreviewStatusCommand(auth, {
      taskId: task.id,
    });

    expect(status.setupTask).toEqual({
      taskId: setupTask.id,
      status: RunStatus.Running,
    });
  });
});

describe('startPreviewSetupTaskCommand', () => {
  it('rejects non-admin callers', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });

    await expect(
      startPreviewSetupTaskCommand(auth, { taskId: task.id }),
    ).rejects.toThrow('Unauthorized');
  });

  it('rejects repo-only tasks', async () => {
    const task = await taskFactory.create({ workflow: 'standard' });
    await runFactory.create({
      taskId: task.id,
      payload: { repo: 'test/repo', description: 'work' } as never,
    });

    await expect(
      startPreviewSetupTaskCommand(adminAuth, { taskId: task.id }),
    ).rejects.toThrow(
      'Live preview setup is only available for environment-backed tasks.',
    );
  });

  it('returns the in-flight setup task instead of launching a duplicate', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });
    const setupTask = await createActiveSetupTask(environment.id);

    await expect(
      startPreviewSetupTaskCommand(adminAuth, { taskId: task.id }),
    ).resolves.toEqual({
      taskId: setupTask.id,
      alreadyRunning: true,
    });
  });

  it('launches with the repair change request in repair mode', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });
    vi.mocked(enqueueTask).mockResolvedValueOnce({
      taskId: 'launched-task',
      id: 999,
    } as never);

    await expect(
      startPreviewSetupTaskCommand(adminAuth, {
        taskId: task.id,
        mode: 'repair',
      }),
    ).resolves.toEqual({ taskId: 'launched-task', alreadyRunning: false });

    const enqueueInput = vi.mocked(enqueueTask).mock.calls.at(-1)?.[0] as {
      title: string;
      task: { payload: { description: string } };
    };
    expect(enqueueInput.title).toMatch(/^Fix live previews: /);
    expect(enqueueInput.task.payload.description).toContain(
      ENVIRONMENT_PREVIEW_REPAIR_CHANGE_REQUEST,
    );
  });

  it('launches with the setup change request by default', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
    });
    const task = await createEnvironmentBackedTask({
      environmentId: environment.id,
    });
    vi.mocked(enqueueTask).mockResolvedValueOnce({
      taskId: 'launched-task-2',
      id: 1000,
    } as never);

    await expect(
      startPreviewSetupTaskCommand(adminAuth, { taskId: task.id }),
    ).resolves.toEqual({ taskId: 'launched-task-2', alreadyRunning: false });

    const enqueueInput = vi.mocked(enqueueTask).mock.calls.at(-1)?.[0] as {
      title: string;
      task: { payload: { description: string } };
    };
    expect(enqueueInput.title).toMatch(/^Set up live previews: /);
    expect(enqueueInput.task.payload.description).toContain(
      ENVIRONMENT_PREVIEW_SETUP_CHANGE_REQUEST,
    );
  });
});
