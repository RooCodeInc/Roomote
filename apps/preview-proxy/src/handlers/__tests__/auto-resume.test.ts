import { TaskPayloadKind } from '@roomote/types';

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
      taskRuns: {
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

  it('preserves the source run acting user when creating a snapshot resume run', async () => {
    const resolution = createMockResolvedRequest({
      status: 'resumable',
      snapshotId: 'snap-preview-1',
      cloudJob: {
        ...createMockCloudJob({
          id: 42,
          actingUserId: 'source-user',
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
            channel: 'C123',
            thread_ts: 'thread-ts-1',
          },
        }),
        port: 3000,
      },
    });

    await triggerAutoResume(resolution, {
      userId: 'viewer-user',
      tokenType: 'pt',
      version: 1,
    });

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'source-user',
        task: expect.objectContaining({
          type: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: 'snap-preview-1',
          sourceCloudJobId: 42,
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
      }),
    );
  });

  it('falls back to the preview token user when the source run has no acting user', async () => {
    const resolution = createMockResolvedRequest({
      status: 'resumable',
      snapshotId: 'snap-preview-2',
      cloudJob: {
        ...createMockCloudJob({
          id: 43,
          actingUserId: null,
          payload: {
            repo: 'owner/repo',
          },
        }),
        port: 3000,
      },
    });

    await triggerAutoResume(resolution, {
      userId: 'viewer-user',
      tokenType: 'pt',
      version: 1,
    });

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'viewer-user',
      }),
    );
  });
});
