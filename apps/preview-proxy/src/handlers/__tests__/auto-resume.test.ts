import { CloudTaskType } from '@roomote/types';

import {
  createMockCloudJob,
  createMockResolvedRequest,
} from '../../__tests__/fixtures';

const { mockFindExistingResume, mockEnqueueCloudTask } = vi.hoisted(() => ({
  mockFindExistingResume: vi.fn(),
  mockEnqueueCloudTask: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  db: {
    query: {
      cloudJobs: {
        findFirst: mockFindExistingResume,
      },
    },
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  escapeForLog: (value: string) => value,
}));

import { triggerAutoResume } from '../auto-resume';

describe('triggerAutoResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindExistingResume.mockResolvedValue(null);
    mockEnqueueCloudTask.mockResolvedValue({ id: 99 });
  });

  it('preserves the source job owner when creating a snapshot resume job', async () => {
    const resolution = createMockResolvedRequest({
      status: 'resumable',
      snapshotId: 'snap-preview-1',
      cloudJob: {
        ...createMockCloudJob({
          id: 42,
          userId: 'source-user',
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
            channel: 'C123',
          },
        }),
        port: 3000,
        slackThreadTs: 'thread-ts-1',
      },
    });

    await triggerAutoResume(resolution, {
      userId: 'viewer-user',
      tokenType: 'pt',
      version: 1,
    });

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'source-user',
        type: CloudTaskType.SnapshotResume,
        sourceSnapshotId: 'snap-preview-1',
        sourceCloudJobId: 42,
        slackThreadTs: 'thread-ts-1',
        payload: expect.objectContaining({
          repo: 'owner/repo',
          environmentId: 'env-1',
          port: 3000,
          sourceSnapshotId: 'snap-preview-1',
          sourceCloudJobId: 42,
          channel: 'C123',
          slackChannel: 'C123',
          thread_ts: 'thread-ts-1',
        }),
      }),
    );
  });
});
