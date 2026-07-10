import { RunStatus } from '@roomote/types';

const {
  mockDequeue,
  mockFindFirstById,
  mockResume,
  mockClientTouchCloudJobHeartbeat,
  mockHeartbeatClientTouchCloudJobHeartbeat,
  mockUpdate,
} = vi.hoisted(() => ({
  mockDequeue: vi.fn(),
  mockFindFirstById: vi.fn(),
  mockResume: vi.fn(),
  mockClientTouchCloudJobHeartbeat: vi.fn(),
  mockHeartbeatClientTouchCloudJobHeartbeat: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('./client', () => ({
  client: {
    cloudJobs: {
      dequeue: { mutate: mockDequeue },
      findFirstById: { query: mockFindFirstById },
      resume: { mutate: mockResume },
      touchCloudJobHeartbeat: { mutate: mockClientTouchCloudJobHeartbeat },
      update: { mutate: mockUpdate },
    },
  },
  workerHeartbeatClient: {
    cloudJobs: {
      touchCloudJobHeartbeat: {
        mutate: mockHeartbeatClientTouchCloudJobHeartbeat,
      },
    },
  },
}));

import {
  dequeue,
  resume,
  syncActingUserId,
  touchCloudJobHeartbeat,
} from './cloud-jobs';

describe('syncActingUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not-found when the cloud job does not exist', async () => {
    mockFindFirstById.mockResolvedValueOnce(null);

    await expect(
      syncActingUserId({ cloudJobId: 42, newUserId: 'user-2' }),
    ).resolves.toBe('not-found');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns unchanged when actingUserId already matches', async () => {
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-2' });

    await expect(
      syncActingUserId({ cloudJobId: 42, newUserId: 'user-2' }),
    ).resolves.toBe('unchanged');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates the cloud job when actingUserId differs', async () => {
    mockFindFirstById.mockResolvedValueOnce({ actingUserId: 'user-1' });
    mockUpdate.mockResolvedValueOnce(undefined);

    await expect(
      syncActingUserId({ cloudJobId: 42, newUserId: 'user-2' }),
    ).resolves.toBe('updated');
    expect(mockUpdate).toHaveBeenCalledWith({
      id: 42,
      actingUserId: 'user-2',
    });
  });
});

describe('dequeue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the bootstrap failure callback for immediate dequeue cancellations', async () => {
    const onBootstrapFailure = vi.fn();
    const cloudJob = {
      id: 42,
      status: RunStatus.Canceled,
      startedAt: null,
      error: 'Cloud job is not valid.',
      type: 'GithubPrReview',
      artifacts: {
        roomoteBootstrapFailure: {
          reason: 'schema_validation_failed',
        },
      },
    };

    mockDequeue.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce(cloudJob);

    await expect(
      dequeue(
        { cloudJobId: 42 },
        {
          onBootstrapFailure,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockFindFirstById).toHaveBeenCalledWith(42);
    expect(onBootstrapFailure).toHaveBeenCalledWith(
      expect.any(Error),
      cloudJob,
    );
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
      { cloudJobId: 42 },
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
      error: 'Superseded by a newer cloud job.',
      type: 'StandardTask',
      artifacts: {},
    });

    await dequeue(
      { cloudJobId: 42 },
      {
        onBootstrapFailure,
      },
    );

    expect(onBootstrapFailure).not.toHaveBeenCalled();
  });
});

describe('touchCloudJobHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes request options through to the client mutation', async () => {
    const controller = new AbortController();
    mockHeartbeatClientTouchCloudJobHeartbeat.mockResolvedValueOnce(undefined);

    await expect(
      touchCloudJobHeartbeat(
        { id: 42 },
        {
          signal: controller.signal,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockHeartbeatClientTouchCloudJobHeartbeat).toHaveBeenCalledWith(
      { id: 42 },
      { signal: controller.signal },
    );
    expect(mockClientTouchCloudJobHeartbeat).not.toHaveBeenCalled();
  });
});

describe('resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the bootstrap failure callback for immediate resume cancellations', async () => {
    const onBootstrapFailure = vi.fn();
    const cloudJob = {
      id: 84,
      status: RunStatus.Canceled,
      startedAt: null,
      error: 'SnapshotResume job 84 has no sourceCloudJobId',
      type: 'SnapshotResume',
      artifacts: {
        roomoteBootstrapFailure: {
          reason: 'missing_source_cloud_job_id',
        },
      },
    };

    mockResume.mockResolvedValueOnce(undefined);
    mockFindFirstById.mockResolvedValueOnce(cloudJob);

    await expect(
      resume(
        { cloudJobId: 84 },
        {
          onBootstrapFailure,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockFindFirstById).toHaveBeenCalledWith(84);
    expect(onBootstrapFailure).toHaveBeenCalledWith(
      expect.any(Error),
      cloudJob,
    );
  });
});
