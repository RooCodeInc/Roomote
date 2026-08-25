const mocks = vi.hoisted(() => ({
  workerOptions: null as Record<string, unknown> | null,
  on: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class Queue {},
  QueueEvents: class QueueEvents {},
  Worker: class Worker {
    constructor(
      _name: string,
      _handler: unknown,
      options: Record<string, unknown>,
    ) {
      mocks.workerOptions = options;
    }
    on = mocks.on;
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  CUSTOM_AUTOMATION_RUN_JOB_NAME: 'run-custom-automation',
  CUSTOM_AUTOMATION_RUN_QUEUE_NAME: 'custom-automation-runs',
  customAutomationRunJobSchema: {
    parse: (value: unknown) => value,
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
  runClaimedFastCustomAutomation: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordCustomAutomationRunOutcome: mocks.recordOutcome,
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({})) }));

import { startCustomAutomationRunQueue } from './custom-automation-run-queue';

describe('custom automation run worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerOptions = null;
    mocks.recordOutcome.mockResolvedValue(true);
  });

  it('disables stalled-job replay and clears the fenced claim on failure', async () => {
    startCustomAutomationRunQueue();

    expect(mocks.workerOptions).toMatchObject({ maxStalledCount: 0 });
    const failedHandler = mocks.on.mock.calls.find(
      ([event]) => event === 'failed',
    )?.[1] as
      | ((job: { id: string; data: unknown }, error: Error) => void)
      | undefined;
    expect(failedHandler).toBeDefined();

    const launchClaimedAt = '2026-08-25T17:41:38.469Z';
    failedHandler?.(
      {
        id: 'invocation-1',
        data: {
          automationId: '11111111-1111-4111-8111-111111111111',
          launchClaimedAt,
        },
      },
      new Error('job stalled'),
    );

    await vi.waitFor(() =>
      expect(mocks.recordOutcome).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          status: 'failed',
          error: 'job stalled',
          launchClaimedAt: new Date(launchClaimedAt),
        }),
      ),
    );
  });
});
