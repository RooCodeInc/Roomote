const mockQueueAdd = vi.fn();

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
  PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS,
  enqueuePullRequestMergeabilityCheck,
} from '../pull-request-mergeability-check';

const request = {
  installationId: 123,
  repository: 'owner/repo',
  taskPullRequestIds: ['11111111-1111-4111-8111-111111111111'],
  deduplicationKey: 'base:owner/repo:main',
  retryAttempt: 0 as const,
  allowNotifiedConflictCheck: false,
};

describe('enqueuePullRequestMergeabilityCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueAdd.mockImplementation(
      (_name: string, _data: unknown, options: { jobId: string }) =>
        Promise.resolve({ id: options.jobId }),
    );
  });

  it('delays and trailing-edge deduplicates the first branch check', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await enqueuePullRequestMergeabilityCheck(request);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-pr-mergeability',
      request,
      {
        jobId: expect.any(String),
        delay: PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
        deduplication: {
          id: 'pr-mergeability:base:owner/repo:main:attempt-0',
          // Capped at the delay so the key cannot outlive the job's
          // promotion and swallow later pushes.
          ttl: PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
          extend: true,
          replace: true,
        },
      },
    );
    const addedJobId = mockQueueAdd.mock.calls[0]?.[2]?.jobId;
    expect(
      log.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .find(
          (entry) => entry.event === 'source_control_pr_mergeability_enqueue',
        ),
    ).toEqual(
      expect.objectContaining({
        provider: 'github',
        repository: 'owner/repo',
        jobId: addedJobId,
        outcome: 'enqueued',
        reason: 'provider_event_check',
      }),
    );
    expect(log.mock.calls.join('\n')).not.toContain(request.deduplicationKey);
    log.mockRestore();
  });

  it('logs a deduplicated request without correlating it to the existing job', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockQueueAdd.mockResolvedValue({ id: 'existing-active-job' });

    await enqueuePullRequestMergeabilityCheck(request);

    const event = log.mock.calls
      .map(([message]) => JSON.parse(String(message)))
      .find(
        (entry) => entry.event === 'source_control_pr_mergeability_enqueue',
      );
    expect(mockQueueAdd.mock.calls[0]?.[2]?.jobId).not.toBe(
      'existing-active-job',
    );
    expect(event).toEqual(
      expect.objectContaining({
        provider: 'github',
        repository: 'owner/repo',
        outcome: 'deduplicated',
        reason: 'provider_event_check',
      }),
    );
    expect(event).not.toHaveProperty('jobId');
    expect(log.mock.calls.join('\n')).not.toContain(request.deduplicationKey);
    log.mockRestore();
  });

  it('rejects a request without any scope', async () => {
    await expect(
      enqueuePullRequestMergeabilityCheck({
        installationId: 123,
        repository: 'owner/repo',
        deduplicationKey: 'base:owner/repo:main',
        retryAttempt: 0,
        allowNotifiedConflictCheck: false,
      }),
    ).rejects.toThrow();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('uses one distinct late-retry delay', async () => {
    await enqueuePullRequestMergeabilityCheck({
      ...request,
      retryAttempt: 1,
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-pr-mergeability',
      expect.objectContaining({ retryAttempt: 1 }),
      expect.objectContaining({
        delay: PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS,
      }),
    );
  });

  it('logs queue failures safely and rethrows them', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockQueueAdd.mockRejectedValue(new Error('redis://secret-host'));

    await expect(enqueuePullRequestMergeabilityCheck(request)).rejects.toThrow(
      'redis://secret-host',
    );

    const event = error.mock.calls
      .map(([message]) => JSON.parse(String(message)))
      .find(
        (entry) => entry.event === 'source_control_pr_mergeability_enqueue',
      );
    expect(event).toEqual(
      expect.objectContaining({
        repository: 'owner/repo',
        outcome: 'failed',
        reason: 'Error',
        retryable: true,
      }),
    );
    expect(error.mock.calls.join('\n')).not.toContain('secret-host');
    error.mockRestore();
  });
});
