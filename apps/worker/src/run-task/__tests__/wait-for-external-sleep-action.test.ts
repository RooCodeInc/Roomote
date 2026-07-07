const { findRuntimeStateByIdMock } = vi.hoisted(() => ({
  findRuntimeStateByIdMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      findRuntimeStateById: findRuntimeStateByIdMock,
    },
  },
}));

import { CloudTaskType } from '@roomote/types';

import { CloudTaskStatus } from '@roomote/types';
import { waitForExternalSleepAction } from '../wait-for-external-sleep-action';

describe('waitForExternalSleepAction', () => {
  beforeEach(() => {
    findRuntimeStateByIdMock.mockReset();
  });

  it('waits for BullMQ to complete a snapshot for resumable jobs', async () => {
    findRuntimeStateByIdMock
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Running,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: new Date(),
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Completed,
      });

    const logger = {
      cloudJobId: 123,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      cloudJob: {
        id: 123,
        type: CloudTaskType.GithubIssueCommentRespond,
        vendor: 'modal',
        machineId: 'sb_test_123',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: true, completed: true });
    expect(findRuntimeStateByIdMock).toHaveBeenCalledWith(123);
  });

  it('waits for BullMQ to complete a shutdown for non-resumable jobs', async () => {
    findRuntimeStateByIdMock
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: null,
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Idle,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: null,
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Completed,
      });

    const logger = {
      cloudJobId: 456,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      cloudJob: {
        id: 456,
        type: CloudTaskType.GithubPrReview,
        vendor: 'modal',
        machineId: 'sb_test_456',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: true, completed: true });
    expect(findRuntimeStateByIdMock).toHaveBeenCalledWith(456);
  });

  it('waits for BullMQ to complete a snapshot for Modal jobs', async () => {
    findRuntimeStateByIdMock
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Running,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: new Date(),
        snapshotFailedAt: null,
        error: null,
        status: CloudTaskStatus.Completed,
      });

    const logger = {
      cloudJobId: 789,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      cloudJob: {
        id: 789,
        type: CloudTaskType.SlackAppMention,
        vendor: 'modal',
        machineId: 'mo_test_789',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: true, completed: true });
    expect(findRuntimeStateByIdMock).toHaveBeenCalledWith(789);
  });

  it('skips jobs on non-snapshot-capable providers', async () => {
    const logger = {
      cloudJobId: 123,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      cloudJob: {
        id: 123,
        type: CloudTaskType.GithubPrReviewFollowUp,
        vendor: 'docker',
        machineId: 'worker-123',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: false, completed: false });
    expect(findRuntimeStateByIdMock).not.toHaveBeenCalled();
  });
});
