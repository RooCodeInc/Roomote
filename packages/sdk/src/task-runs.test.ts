import { RunStatus } from '@roomote/types';

const {
  mockDequeue,
  mockFindFirstById,
  mockResume,
  mockClientTouchTaskRunHeartbeat,
  mockHeartbeatClientTouchTaskRunHeartbeat,
  mockUpdate,
} = vi.hoisted(() => ({
  mockDequeue: vi.fn(),
  mockFindFirstById: vi.fn(),
  mockResume: vi.fn(),
  mockClientTouchTaskRunHeartbeat: vi.fn(),
  mockHeartbeatClientTouchTaskRunHeartbeat: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('./client', () => ({
  client: {
    taskRuns: {
      dequeue: { mutate: mockDequeue },
      findFirstById: { query: mockFindFirstById },
      resume: { mutate: mockResume },
      touchTaskRunHeartbeat: { mutate: mockClientTouchTaskRunHeartbeat },
      update: { mutate: mockUpdate },
    },
  },
  workerHeartbeatClient: {
    taskRuns: {
      touchTaskRunHeartbeat: {
        mutate: mockHeartbeatClientTouchTaskRunHeartbeat,
      },
    },
  },
}));

import {
  dequeue,
  resume,
  syncActingUserId,
  touchTaskRunHeartbeat,
} from './task-runs';

describe('syncActingUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not-found when the task run does not exist', async () => {
    mockFindFirstById.mockResolvedValueOnce(null);

    await expect(
      syncActingUserId({ runId: 42, newUserId: 'user-2' }),
    ).resolves.toEqual({ result: 'not-found' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns unchanged when the server, sender, and local state agree', async () => {
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-2' });

    await expect(
      syncActingUserId({
        runId: 42,
        newUserId: 'user-2',
        lastKnownUserId: 'user-2',
      }),
    ).resolves.toEqual({ result: 'unchanged', actingUserId: 'user-2' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns updated when the server actor matches the sender but local state lags', async () => {
    // A trusted server-side writer switched the run to this sender; the
    // worker must refresh its integrations and git author from the server.
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-2' });

    await expect(
      syncActingUserId({
        runId: 42,
        newUserId: 'user-2',
        lastKnownUserId: 'user-1',
      }),
    ).resolves.toEqual({ result: 'updated', actingUserId: 'user-2' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns updated on a match when the local state is unknown', async () => {
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-2' });

    await expect(
      syncActingUserId({ runId: 42, newUserId: 'user-2' }),
    ).resolves.toEqual({ result: 'updated', actingUserId: 'user-2' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never reassigns actingUserId via the run token and reports a mismatch', async () => {
    // Security: run tokens (held by the sandbox) must not be able to steer
    // the run's acting user, or a compromised sandbox could pivot to another
    // user's actor-scoped credentials. The worker only observes the value.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-1' });

    await expect(
      syncActingUserId({
        runId: 42,
        newUserId: 'user-2',
        lastKnownUserId: 'user-1',
      }),
    ).resolves.toEqual({ result: 'mismatch', actingUserId: 'user-1' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot reassign the acting user'),
    );

    warnSpy.mockRestore();
  });
});

describe('dequeue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the bootstrap failure callback for immediate dequeue cancellations', async () => {
    const onBootstrapFailure = vi.fn();
    const taskRun = {
      id: 42,
      status: RunStatus.Canceled,
      startedAt: null,
      error: 'Task run is not valid.',
      type: 'GithubPrReview',
      artifacts: {
        roomoteBootstrapFailure: {
          reason: 'schema_validation_failed',
        },
      },
    };

    mockDequeue.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce(taskRun);

    await expect(
      dequeue(
        { runId: 42 },
        {
          onBootstrapFailure,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockFindFirstById).toHaveBeenCalledWith(42);
    expect(onBootstrapFailure).toHaveBeenCalledWith(expect.any(Error), taskRun);
  });

  it('does not invoke the bootstrap failure callback after dequeue startup has begun', async () => {
    const onBootstrapFailure = vi.fn();

    mockDequeue.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce({
      id: 42,
      status: RunStatus.Canceled,
      startedAt: new Date('2026-04-21T00:00:00.000Z'),
      error: 'Failed to create GitHub token.',
      type: 'GithubPrReview',
      artifacts: {
        roomoteBootstrapFailure: {
          reason: 'missing_github_token',
        },
      },
    });

    await dequeue(
      { runId: 42 },
      {
        onBootstrapFailure,
      },
    );

    expect(onBootstrapFailure).not.toHaveBeenCalled();
  });

  it('does not invoke the bootstrap failure callback for generic pre-start cancellations without an explicit signal', async () => {
    const onBootstrapFailure = vi.fn();

    mockDequeue.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce({
      id: 42,
      status: RunStatus.Canceled,
      startedAt: null,
      error: 'Superseded by a newer task run.',
      type: 'StandardTask',
      artifacts: {},
    });

    await dequeue(
      { runId: 42 },
      {
        onBootstrapFailure,
      },
    );

    expect(onBootstrapFailure).not.toHaveBeenCalled();
  });
});

describe('touchTaskRunHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes request options through to the client mutation', async () => {
    const controller = new AbortController();
    mockHeartbeatClientTouchTaskRunHeartbeat.mockResolvedValueOnce(undefined);

    await expect(
      touchTaskRunHeartbeat(
        { id: 42 },
        {
          signal: controller.signal,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockHeartbeatClientTouchTaskRunHeartbeat).toHaveBeenCalledWith(
      { id: 42 },
      { signal: controller.signal },
    );
    expect(mockClientTouchTaskRunHeartbeat).not.toHaveBeenCalled();
  });
});

describe('resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the bootstrap failure callback for immediate resume cancellations', async () => {
    const onBootstrapFailure = vi.fn();
    const taskRun = {
      id: 84,
      status: RunStatus.Canceled,
      startedAt: null,
      error: 'SnapshotResume run 84 has no sourceRunId',
      type: 'SnapshotResume',
      artifacts: {
        roomoteBootstrapFailure: {
          reason: 'missing_source_task_run_id',
        },
      },
    };

    mockResume.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce(taskRun);

    await expect(
      resume(
        { runId: 84 },
        {
          onBootstrapFailure,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockFindFirstById).toHaveBeenCalledWith(84);
    expect(onBootstrapFailure).toHaveBeenCalledWith(expect.any(Error), taskRun);
  });
});
