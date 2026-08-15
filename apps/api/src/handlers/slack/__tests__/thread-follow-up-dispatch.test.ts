import {
  dispatchSlackThreadFollowUp,
  resolveSlackThreadFollowUpRoute,
} from '../events/thread-follow-up-dispatch';

const {
  findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshotMock,
} = vi.hoisted(() => ({
  findActiveSlackTaskRunMock: vi.fn(),
  findCompletedSlackTaskRunWithSnapshotMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshot:
    findCompletedSlackTaskRunWithSnapshotMock,
}));

describe('Slack thread follow-up dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    findCompletedSlackTaskRunWithSnapshotMock.mockResolvedValue(null);
  });

  it('keeps route resolution side-effect free and returns the active task run when one is already running', async () => {
    const activeRun = {
      id: 42,
      taskId: 'task-42',
      result: null,
    } as NonNullable<
      Parameters<
        typeof resolveSlackThreadFollowUpRoute
      >[0]['prefetchedActiveRun']
    >;

    const route = await resolveSlackThreadFollowUpRoute({
      threadId: '111.000',
      slackTeamId: 'T1',
      prefetchedActiveRun: activeRun,
      allowCompletedResume: false,
    });

    expect(route).toEqual({ kind: 'active', activeRun });
    expect(findActiveSlackTaskRunMock).not.toHaveBeenCalled();
    expect(findCompletedSlackTaskRunWithSnapshotMock).not.toHaveBeenCalled();
  });

  it('scopes active and snapshot lookup to the Slack workspace', async () => {
    await resolveSlackThreadFollowUpRoute({
      threadId: '111.000',
      slackTeamId: 'T2',
    });

    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith('111.000', {
      slackTeamId: 'T2',
    });
    expect(findCompletedSlackTaskRunWithSnapshotMock).toHaveBeenCalledWith(
      '111.000',
      { slackTeamId: 'T2' },
    );
  });

  it('routes a tracked automation alias by task id without requiring the canonical thread binding', async () => {
    await resolveSlackThreadFollowUpRoute({
      threadId: '111.000',
      slackTeamId: 'T2',
      taskId: 'task-source',
    });

    const aliasScope = {
      taskId: 'task-source',
      matchTaskIdWithoutThread: true,
    };
    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith(
      '111.000',
      aliasScope,
    );
    expect(findCompletedSlackTaskRunWithSnapshotMock).toHaveBeenCalledWith(
      '111.000',
      aliasScope,
    );
  });

  it('falls back to a fresh launch when resume handling declines the completed task run', async () => {
    const onFresh = vi.fn().mockResolvedValue('started-fresh');

    const outcome = await dispatchSlackThreadFollowUp({
      route: {
        kind: 'resume',
        completedRun: {
          id: 100,
          taskId: 'task-100',
          snapshotId: 'snap-100',
          userId: 'user-1',
          payload: {} as never,
          port: 3000,
          result: null,
        } as never,
      },
      slack: { postMessage: vi.fn() } as never,
      channel: 'C123',
      threadId: '111.000',
      onResume: vi.fn().mockResolvedValue({ handled: false }),
      onFresh,
    });

    expect(outcome).toEqual({
      kind: 'fresh',
      value: 'started-fresh',
    });
    expect(onFresh).toHaveBeenCalledTimes(1);
  });
});
