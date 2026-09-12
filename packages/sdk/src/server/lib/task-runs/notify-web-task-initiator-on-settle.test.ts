import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  findTask: vi.fn(),
  getSessionForTask: vi.fn(),
  isPresent: vi.fn(),
  recordEvent: vi.fn(),
  returning: vi.fn(),
  selectTaskStateRun: vi.fn(),
  sendPersonalNotification: vi.fn(),
}));

function updateChain() {
  const terminal = {
    returning: (...args: unknown[]) => mocks.returning(...args),
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  };
  return { set: () => ({ where: () => terminal }) };
}

vi.mock('@roomote/db/server', () => ({
  and: (...args: unknown[]) => args,
  db: {
    query: { tasks: { findFirst: mocks.findTask } },
    update: vi.fn(updateChain),
  },
  eq: (...args: unknown[]) => args,
  getSessionForTask: mocks.getSessionForTask,
  recordTaskRunLifecycleEvent: mocks.recordEvent,
  selectTaskStateRun: mocks.selectTaskStateRun,
  sql: vi.fn(),
  taskRuns: { id: 'taskRuns.id', result: 'taskRuns.result' },
  tasks: { id: 'tasks.id' },
}));
vi.mock('@roomote/redis', () => ({
  isSessionUserPresent: mocks.isPresent,
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: ({ taskId }: { taskId: string }) =>
    `https://roomote.test/task/${taskId}`,
}));
vi.mock('../user-direct-message', () => ({
  sendUserDirectMessageBestEffort: mocks.sendPersonalNotification,
}));
vi.mock('./fast-agent-delivery-claim', () => ({
  buildDeliveryClaimMarker: () => 'delivering:1',
  buildDeliveryClaimPredicate: () => true,
}));

import { notifyWebTaskInitiatorOnSettle } from './notify-web-task-initiator-on-settle';

const run = { id: 42, taskId: 'task-1' };
const eligibleTask = {
  id: 'task-1',
  initiatorUserId: 'user-1',
  state: 'completed',
  surface: 'web',
  title: 'Ship notification fallback',
  runs: [{ id: 42, status: RunStatus.Completed, startedAt: new Date() }],
};

describe('notifyWebTaskInitiatorOnSettle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTask.mockResolvedValue(eligibleTask);
    mocks.selectTaskStateRun.mockReturnValue(eligibleTask.runs[0]);
    mocks.returning.mockResolvedValue([{ id: run.id }]);
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-1' });
    mocks.isPresent.mockResolvedValue(false);
    mocks.sendPersonalNotification.mockResolvedValue(['slack']);
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it.each([
    [RunStatus.Completed, 'completed'],
    [RunStatus.Failed, 'failed'],
    [RunStatus.Canceled, 'was canceled'],
  ] as const)(
    'delivers a %s settle through the personal waterfall',
    async (status, label) => {
      mocks.findTask.mockResolvedValue({
        ...eligibleTask,
        state: status,
        runs: [{ ...eligibleTask.runs[0], status }],
      });
      mocks.selectTaskStateRun.mockReturnValue({
        ...eligibleTask.runs[0],
        status,
      });
      await notifyWebTaskInitiatorOnSettle(run, status);

      expect(mocks.sendPersonalNotification).toHaveBeenCalledWith({
        userId: 'user-1',
        text: expect.stringContaining(
          `**Ship notification fallback** ${label}.`,
        ),
        logContext: 'notifyWebTaskInitiatorOnSettle',
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      });
    },
  );

  it('suppresses delivery while the initiating user is viewing the Session', async () => {
    mocks.isPresent.mockResolvedValue(true);

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).not.toHaveBeenCalled();
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'web_initiator_settlement_skipped_present',
        }),
      }),
    );
  });

  it.each([
    ['non-web origin', { surface: 'slack' }],
    ['missing initiating user', { initiatorUserId: null }],
    ['task still active', { state: 'active' }],
  ])('suppresses %s', async (_label, override) => {
    mocks.findTask.mockResolvedValue({ ...eligibleTask, ...override });

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).not.toHaveBeenCalled();
    expect(mocks.isPresent).not.toHaveBeenCalled();
  });

  it('suppresses a terminal sibling that did not define the task outcome', async () => {
    mocks.selectTaskStateRun.mockReturnValue({
      id: 43,
      status: RunStatus.Completed,
      startedAt: new Date(),
    });

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).not.toHaveBeenCalled();
  });

  it('releases a failed delivery claim so a later finalization can retry', async () => {
    mocks.sendPersonalNotification.mockResolvedValue([]);

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);
    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).toHaveBeenCalledTimes(2);
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'web_initiator_settlement_delivery_failed',
        }),
      }),
    );
  });

  it('does not duplicate a delivery whose claim is already terminal or active', async () => {
    mocks.returning.mockResolvedValue([]);

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).not.toHaveBeenCalled();
  });

  it('fails open when presence cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.isPresent.mockRejectedValue(new Error('redis unavailable'));

    await notifyWebTaskInitiatorOnSettle(run, RunStatus.Completed);

    expect(mocks.sendPersonalNotification).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Presence lookup failed'),
    );
    warn.mockRestore();
  });
});
