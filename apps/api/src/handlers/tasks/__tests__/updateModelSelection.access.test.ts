import { Hono } from 'hono';

import {
  automations,
  customAutomations,
  db,
  eq,
  inArray,
  runFactory,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const { mockWithSandboxServerRpcClient } = vi.hoisted(() => ({
  mockWithSandboxServerRpcClient: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  withSandboxServerRpcClient: mockWithSandboxServerRpcClient,
}));

import { updateTaskModelSelection } from '../updateModelSelection';

type User = Awaited<ReturnType<typeof userFactory.create>>;

const createdAutomationIds: string[] = [];
const createdRunIds: number[] = [];
const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

async function createUser(role: 'admin' | 'member') {
  const user = await userFactory.create({ role });
  createdUserIds.push(user.id);
  return user;
}

function createApp(user: User) {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId: user.id,
      authContext: {
        userId: user.id,
        tokenType: 'auth',
        version: 1,
      },
    });
    await next();
  });
  app.post('/tasks/:taskId/model_selection', updateTaskModelSelection);
  return app;
}

function postModelSelection(
  app: ReturnType<typeof createApp>,
  taskId: string,
  reasoningEffort: 'high' | 'low',
) {
  return app.request(`/tasks/${taskId}/model_selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'helper',
      model: null,
      reasoningEffort,
    }),
  });
}

async function createAutomationTask(owner: User) {
  await db
    .insert(automations)
    .values({ key: 'custom_automation' })
    .onConflictDoNothing();
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: `Model selection access ${owner.id}`,
      prompt: 'Private task',
      createdByUserId: owner.id,
    })
    .returning();
  createdAutomationIds.push(automation!.id);
  const task = await taskFactory.create({
    initiatorKind: 'automation',
    initiatorAutomation: 'custom_automation',
    actorExternalId: automation!.id,
  });
  createdTaskIds.push(task.id);
  const run = await runFactory.create({
    taskId: task.id,
    status: RunStatus.Running,
    sandboxServerUrl: 'http://sandbox.example.test',
    payload: { repo: 'test/repo', description: 'Private task' },
  });
  createdRunIds.push(run.id);
  return { task, run };
}

async function getRunPayload(runId: number) {
  return (
    await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: { payload: true },
    })
  )?.payload;
}

describe('updateTaskModelSelection task access', () => {
  beforeEach(() => {
    mockWithSandboxServerRpcClient.mockReset();
    mockWithSandboxServerRpcClient.mockResolvedValue({
      application: 'restarted',
    });
  });

  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.id, createdRunIds));
    }
    if (createdTaskIds.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
    if (createdAutomationIds.length > 0) {
      await db
        .delete(customAutomations)
        .where(inArray(customAutomations.id, createdAutomationIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    createdRunIds.length = 0;
    createdTaskIds.length = 0;
    createdAutomationIds.length = 0;
    createdUserIds.length = 0;
    vi.restoreAllMocks();
  });

  it('denies another member without persistence or a live restart', async () => {
    const owner = await createUser('member');
    const other = await createUser('member');
    const { task, run } = await createAutomationTask(owner);
    const originalPayload = await getRunPayload(run.id);

    const response = await postModelSelection(
      createApp(other),
      task.id,
      'high',
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Task not found',
    });
    expect(await getRunPayload(run.id)).toEqual(originalPayload);
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it.each([
    ['automation owner', 'member'],
    ['admin', 'admin'],
  ] as const)('allows the %s', async (_label, role) => {
    const owner = await createUser('member');
    const actor = role === 'admin' ? await createUser('admin') : owner;
    const { task, run } = await createAutomationTask(owner);

    const response = await postModelSelection(
      createApp(actor),
      task.id,
      'high',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      application: 'restarted',
    });
    expect((await getRunPayload(run.id))?.modelRoleOverrides?.helper).toEqual({
      reasoningEffort: 'high',
    });
    expect(mockWithSandboxServerRpcClient).toHaveBeenCalledOnce();
  });

  it('preserves member access to ordinary deployment tasks', async () => {
    const owner = await createUser('member');
    const other = await createUser('member');
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    createdTaskIds.push(task.id);
    const run = await runFactory.create({ taskId: task.id });
    createdRunIds.push(run.id);

    const response = await postModelSelection(
      createApp(other),
      task.id,
      'high',
    );

    expect(response.status).toBe(200);
    expect((await getRunPayload(run.id))?.modelRoleOverrides?.helper).toEqual({
      reasoningEffort: 'high',
    });
  });

  it('persists a failed live apply and restarts on a later recovery', async () => {
    const owner = await createUser('member');
    const { task, run } = await createAutomationTask(owner);
    mockWithSandboxServerRpcClient
      .mockRejectedValueOnce(new Error('sandbox unavailable'))
      .mockResolvedValueOnce({ application: 'restarted' });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const failedApply = await postModelSelection(
      createApp(owner),
      task.id,
      'high',
    );
    expect(failedApply.status).toBe(200);
    expect(await failedApply.json()).toEqual({
      success: true,
      application: 'offline',
    });
    expect((await getRunPayload(run.id))?.modelRoleOverrides?.helper).toEqual({
      reasoningEffort: 'high',
    });

    const recoveredApply = await postModelSelection(
      createApp(owner),
      task.id,
      'low',
    );
    expect(await recoveredApply.json()).toEqual({
      success: true,
      application: 'restarted',
    });
    expect((await getRunPayload(run.id))?.modelRoleOverrides?.helper).toEqual({
      reasoningEffort: 'low',
    });
    expect(mockWithSandboxServerRpcClient).toHaveBeenCalledTimes(2);
  });
});
