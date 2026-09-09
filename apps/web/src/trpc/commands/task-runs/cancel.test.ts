import {
  automations,
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
} from '@roomote/db/server';
import {
  activeRunStatuses,
  exitedRunStatuses,
  RunStatus,
} from '@roomote/types';
import { captureTaskSettled } from '@roomote/telemetry/server';
import { settleSlackLiveTaskCardForRun } from '@roomote/slack';
import type { UserAuthSuccess } from '@/types';

vi.mock('@roomote/telemetry/server', () => ({ captureTaskSettled: vi.fn() }));
vi.mock('@roomote/slack', () => ({ settleSlackLiveTaskCardForRun: vi.fn() }));
vi.mock('../sandbox-session', () => ({ sendSandboxPromptCommand: vi.fn() }));
vi.mock('../tasks/by-id', () => ({ resolveTaskByIdAccessCommand: vi.fn() }));
vi.mock('./retry-failed-start', () => ({
  retryFailedTaskStartCommand: vi.fn(),
}));

import { cancelTaskRunCommand } from './index';

const auth = {
  success: true,
  userType: 'user',
  userId: 'cancel-test-user',
  name: 'Test User',
  primaryEmail: 'test@example.com',
  isAdmin: false,
  anonymousAnalyticsEnabled: false,
  cloudEnabled: false,
  cookieConsentedAt: null,
  resource: {
    username: null,
    fullName: null,
    firstName: null,
    lastName: null,
    primaryEmailAddress: null,
    emailAddresses: [],
    imageUrl: '',
    createdAt: null,
  },
} satisfies UserAuthSuccess;

const readRun = (id: number) =>
  db.query.taskRuns.findFirst({ where: eq(taskRuns.id, id) });

describe('cancelTaskRunCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(activeRunStatuses)(
    'cancels only the supplied %s run',
    async (status) => {
      const task = await taskFactory.create();
      const selected = await runFactory.create({
        taskId: task.id,
        status,
      });
      const newer = await runFactory.create({
        taskId: task.id,
        status: RunStatus.Running,
      });

      await expect(
        cancelTaskRunCommand(auth, { taskId: task.id, runId: selected.id }),
      ).resolves.toEqual({ success: true });

      expect(await readRun(selected.id)).toMatchObject({
        status: RunStatus.Canceled,
        canceledAt: expect.any(Date),
      });
      expect(await readRun(newer.id)).toEqual(newer);
      expect(captureTaskSettled).toHaveBeenCalledExactlyOnceWith(
        selected.id,
        'canceled',
      );
      expect(settleSlackLiveTaskCardForRun).toHaveBeenCalledExactlyOnceWith({
        taskId: task.id,
        payload: selected.payload,
        status: RunStatus.Canceled,
      });
    },
  );

  it.each(['mismatched', 'missing'])(
    'does not fall back for a %s run ID',
    async (kind) => {
      const selected = await runFactory.create();
      const other = await runFactory.create();
      await expect(
        cancelTaskRunCommand(auth, {
          taskId: selected.taskId,
          runId: kind === 'mismatched' ? other.id : -1,
        }),
      ).resolves.toEqual({ success: false, error: 'Task run not found' });
      expect(await readRun(selected.id)).toEqual(selected);
      expect(await readRun(other.id)).toEqual(other);
      expect(captureTaskSettled).not.toHaveBeenCalled();
      expect(settleSlackLiveTaskCardForRun).not.toHaveBeenCalled();
    },
  );

  it.each(exitedRunStatuses)(
    'is idempotent for an explicit %s run beside a newer active run',
    async (status) => {
      const terminal = await runFactory.create({
        status,
      });
      const active = await runFactory.create({
        taskId: terminal.taskId,
        status: RunStatus.Running,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          cancelTaskRunCommand(auth, {
            taskId: terminal.taskId,
            runId: terminal.id,
          }),
        ).resolves.toEqual({ success: true });
      }
      expect(await readRun(terminal.id)).toEqual(terminal);
      expect(await readRun(active.id)).toEqual(active);
      expect(captureTaskSettled).not.toHaveBeenCalled();
      expect(settleSlackLiveTaskCardForRun).not.toHaveBeenCalled();
    },
  );

  it('settles a repeatedly canceled run only once', async () => {
    const run = await runFactory.create();
    await cancelTaskRunCommand(auth, { taskId: run.taskId, runId: run.id });
    const canceled = await readRun(run.id);
    await cancelTaskRunCommand(auth, { taskId: run.taskId, runId: run.id });
    expect(await readRun(run.id)).toEqual(canceled);
    expect(captureTaskSettled).toHaveBeenCalledTimes(1);
    expect(settleSlackLiveTaskCardForRun).toHaveBeenCalledTimes(1);
  });

  it('keeps task-only selection of the newest active run with ID tie-breaking', async () => {
    const createdAt = new Date('2026-01-01');
    const older = await runFactory.create();
    const newestActive = await runFactory.create({
      taskId: older.taskId,
    });
    await db
      .update(taskRuns)
      .set({ createdAt })
      .where(eq(taskRuns.taskId, older.taskId));
    const olderBefore = await readRun(older.id);
    const terminal = await runFactory.create({
      taskId: older.taskId,
      status: RunStatus.Completed,
    });
    await expect(
      cancelTaskRunCommand(auth, { taskId: older.taskId }),
    ).resolves.toEqual({ success: true });
    expect(await readRun(older.id)).toEqual(olderBefore);
    expect(await readRun(newestActive.id)).toMatchObject({
      status: RunStatus.Canceled,
    });
    expect(await readRun(terminal.id)).toEqual(terminal);
  });

  it('keeps task-only terminal fallback and reports tasks without runs', async () => {
    const terminal = await runFactory.create({ status: RunStatus.Completed });
    await expect(
      cancelTaskRunCommand(auth, { taskId: terminal.taskId }),
    ).resolves.toEqual({ success: true });
    expect(await readRun(terminal.id)).toEqual(terminal);
    const empty = await taskFactory.create();
    await expect(
      cancelTaskRunCommand(auth, { taskId: empty.id }),
    ).resolves.toEqual({ success: false, error: 'Task run not found' });
  });

  it('preserves task authorization before cancellation', async () => {
    await db
      .insert(automations)
      .values({ key: 'custom_automation' })
      .onConflictDoNothing();
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'custom_automation',
      actorExternalId: 'unowned-automation',
    });
    const run = await runFactory.create({ taskId: task.id });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await expect(
        cancelTaskRunCommand(auth, { taskId: task.id, runId: run.id }),
      ).resolves.toEqual({ success: false, error: 'Task not found' });
      expect(await readRun(run.id)).toEqual(run);
      expect(captureTaskSettled).not.toHaveBeenCalled();
      expect(settleSlackLiveTaskCardForRun).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
