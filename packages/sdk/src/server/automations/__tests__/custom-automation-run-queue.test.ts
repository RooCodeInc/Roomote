const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class Queue {
    add = mocks.add;
    getJob = mocks.getJob;
  },
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));

import {
  CUSTOM_AUTOMATION_RUN_JOB_NAME,
  enqueueCustomAutomationRun,
  getCustomAutomationRunStatus,
} from '../custom-automation-run-queue';

const automationId = '11111111-1111-4111-8111-111111111111';
const launchClaimedAt = new Date('2026-08-25T17:41:38.469Z');
const invocationId = `${automationId}-${launchClaimedAt.getTime()}`;

describe('custom automation run queue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a durable invocation with a deterministic identifier', async () => {
    await expect(
      enqueueCustomAutomationRun({ automationId, launchClaimedAt }),
    ).resolves.toBe(invocationId);

    expect(mocks.add).toHaveBeenCalledWith(
      CUSTOM_AUTOMATION_RUN_JOB_NAME,
      { automationId, launchClaimedAt: launchClaimedAt.toISOString() },
      { jobId: invocationId },
    );
  });

  it('reports successful terminal status', async () => {
    mocks.getJob.mockResolvedValue({
      data: { automationId },
      getState: vi.fn().mockResolvedValue('completed'),
    });

    await expect(
      getCustomAutomationRunStatus({ automationId, invocationId }),
    ).resolves.toEqual({ automationId, invocationId, status: 'succeeded' });
  });

  it('reports failed terminal status', async () => {
    mocks.getJob.mockResolvedValue({
      data: { automationId },
      failedReason: 'provider unavailable',
      getState: vi.fn().mockResolvedValue('failed'),
    });

    await expect(
      getCustomAutomationRunStatus({ automationId, invocationId }),
    ).resolves.toEqual({
      automationId,
      invocationId,
      status: 'failed',
      error: 'provider unavailable',
    });
  });
});
