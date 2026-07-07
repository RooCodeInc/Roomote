const mockQueue = {
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  getJobSchedulers: vi.fn().mockResolvedValue([]),
};
const mockWorkerOn = vi.fn();
const mockQueueEventsOn = vi.fn();
const mockRefreshSandboxOidcJob = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return mockQueue;
  }),
  Worker: vi.fn(function Worker(_name, processor, options) {
    return {
      on: mockWorkerOn,
      processor,
      options,
    };
  }),
  QueueEvents: vi.fn(function QueueEvents() {
    return { on: mockQueueEventsOn };
  }),
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => ({ status: 'ready' })),
}));

vi.mock('./scheduled-jobs/refresh-sandbox-oidc', () => ({
  refreshSandboxOidcJob: (...args: unknown[]) =>
    mockRefreshSandboxOidcJob(...args),
}));

import { Queue, Worker } from 'bullmq';

import { startSandboxOidcRefreshQueue } from './sandbox-oidc-refresh-queue';

describe('startSandboxOidcRefreshQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueue.upsertJobScheduler.mockResolvedValue(undefined);
    mockQueue.getJobSchedulers.mockResolvedValue([]);
    mockRefreshSandboxOidcJob.mockResolvedValue(undefined);
  });

  it('uses a dedicated queue and scheduler for sandbox OIDC refresh', async () => {
    startSandboxOidcRefreshQueue();
    await vi.waitFor(() =>
      expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
        'RefreshSandboxOidc',
        { every: 60_000 },
      ),
    );

    expect(Queue).toHaveBeenCalledWith(
      'sandbox-oidc-refresh-jobs',
      expect.any(Object),
    );
    expect(Worker).toHaveBeenCalledWith(
      'sandbox-oidc-refresh-jobs',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1, autorun: true }),
    );
  });
});
