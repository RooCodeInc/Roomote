import {
  dispatchSlackThreadFollowUp,
  resolveSlackThreadFollowUpRoute,
} from '../events/thread-follow-up-dispatch';

const { findActiveSlackJobMock, findCompletedSlackJobWithSnapshotMock } =
  vi.hoisted(() => ({
    findActiveSlackJobMock: vi.fn(),
    findCompletedSlackJobWithSnapshotMock: vi.fn(),
  }));

vi.mock('@roomote/slack', () => ({
  findActiveSlackJob: findActiveSlackJobMock,
  findCompletedSlackJobWithSnapshot: findCompletedSlackJobWithSnapshotMock,
}));

describe('Slack thread follow-up dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveSlackJobMock.mockResolvedValue(null);
    findCompletedSlackJobWithSnapshotMock.mockResolvedValue(null);
  });

  it('keeps route resolution side-effect free and returns the active job when one is already running', async () => {
    const activeJob = {
      id: 42,
      taskId: 'task-42',
      result: null,
    } as NonNullable<
      Parameters<
        typeof resolveSlackThreadFollowUpRoute
      >[0]['prefetchedActiveJob']
    >;

    const route = await resolveSlackThreadFollowUpRoute({
      threadId: '111.000',
      prefetchedActiveJob: activeJob,
      allowCompletedResume: false,
    });

    expect(route).toEqual({ kind: 'active', activeJob });
    expect(findActiveSlackJobMock).not.toHaveBeenCalled();
    expect(findCompletedSlackJobWithSnapshotMock).not.toHaveBeenCalled();
  });

  it('falls back to a fresh launch when resume handling declines the completed job', async () => {
    const onFresh = vi.fn().mockResolvedValue('started-fresh');

    const outcome = await dispatchSlackThreadFollowUp({
      route: {
        kind: 'resume',
        completedJob: {
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
