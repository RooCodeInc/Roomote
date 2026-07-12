const { findRuntimeStateByIdMock } = vi.hoisted(() => ({
  findRuntimeStateByIdMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      findRuntimeStateById: findRuntimeStateByIdMock,
    },
  },
}));

import { TaskPayloadKind } from '@roomote/types';

import { RunStatus } from '@roomote/types';
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
        status: RunStatus.Running,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: new Date(),
        snapshotFailedAt: null,
        error: null,
        status: RunStatus.Completed,
      });

    const logger = {
      runId: 123,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      taskRun: {
        id: 123,
        payloadKind: TaskPayloadKind.StandardTask,
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
        status: RunStatus.Idle,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: null,
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: RunStatus.Completed,
      });

    const logger = {
      runId: 456,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      taskRun: {
        id: 456,
        payloadKind: TaskPayloadKind.GithubPrReview,
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
        status: RunStatus.Running,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: new Date(),
        snapshotCreatedAt: new Date(),
        snapshotFailedAt: null,
        error: null,
        status: RunStatus.Completed,
      });

    const logger = {
      runId: 789,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      taskRun: {
        id: 789,
        payloadKind: TaskPayloadKind.SlackAppMention,
        vendor: 'modal',
        machineId: 'mo_test_789',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: true, completed: true });
    expect(findRuntimeStateByIdMock).toHaveBeenCalledWith(789);
  });

  it('waits for BullMQ to retain a resumable Blaxel sandbox on standby', async () => {
    findRuntimeStateByIdMock
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: null,
        snapshotCreatedAt: null,
        snapshotFailedAt: null,
        error: null,
        status: RunStatus.Idle,
      })
      .mockResolvedValueOnce({
        sleepRequestedAt: new Date(),
        snapshotRequestedAt: null,
        snapshotCreatedAt: new Date(),
        snapshotFailedAt: null,
        error: null,
        status: RunStatus.Completed,
      });

    const logger = {
      runId: 790,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      taskRun: {
        id: 790,
        payloadKind: TaskPayloadKind.StandardTask,
        vendor: 'blaxel',
        machineId: 'roomote-blaxel-790',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: true, completed: true });
    expect(findRuntimeStateByIdMock).toHaveBeenCalledWith(790);
  });

  it('skips jobs on non-sleep-check-managed providers', async () => {
    const logger = {
      runId: 123,
      filePath: '/tmp/test.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await waitForExternalSleepAction({
      taskRun: {
        id: 123,
        payloadKind: TaskPayloadKind.GithubPrReviewFollowUp,
        vendor: 'not-a-provider',
        machineId: 'worker-123',
      } as never,
      logger,
    });

    expect(result).toEqual({ claimed: false, completed: false });
    expect(findRuntimeStateByIdMock).not.toHaveBeenCalled();
  });
});
