const {
  mockProcess,
  mockWorkerOn,
  mockQueueConstructor,
  mockWorkerConstructor,
  mockQueueEventsConstructor,
} = vi.hoisted(() => ({
  mockProcess: vi.fn(),
  mockWorkerOn: vi.fn(),
  mockQueueConstructor: vi.fn(),
  mockWorkerConstructor: vi.fn(),
  mockQueueEventsConstructor: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  HOME_COMPOSER_RECOMMENDATION_JOB_OPTIONS: { attempts: 3 },
  HOME_COMPOSER_RECOMMENDATIONS_QUEUE_NAME: 'home-composer-recommendations',
  processHomeComposerRecommendationPrecompute: mockProcess,
}));

vi.mock('./redis', () => ({ getRedis: () => ({}) }));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    constructor(...args: unknown[]) {
      mockQueueConstructor(...args);
    }
  },
  Worker: class MockWorker {
    constructor(...args: unknown[]) {
      mockWorkerConstructor(...args);
    }
    on = mockWorkerOn;
  },
  QueueEvents: class MockQueueEvents {
    constructor(...args: unknown[]) {
      mockQueueEventsConstructor(...args);
    }
  },
}));

import { startHomeComposerRecommendationsQueue } from './home-composer-recommendations-queue';

describe('Home composer recommendations queue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs a separate low-concurrency worker and logs privacy-safe timing', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    mockProcess.mockResolvedValue({
      suggestions: ['private suggestion', 'two', 'three', 'four', 'five'],
      outcome: 'generated',
      eligibleReferenceCount: 5,
      readableMemoryCount: 5,
      timing: {
        totalMs: 120,
        preferenceGuardMs: 2,
        eligibleReferenceLookupMs: 3,
        cacheStatus: 'miss',
        cacheMs: 1,
        cachedSourceValidationMs: null,
        brainReadsMs: 14,
        helperGenerationMs: 95,
        postGenerationValidationMs: 5,
      },
    });

    startHomeComposerRecommendationsQueue();

    expect(mockQueueConstructor).toHaveBeenCalledWith(
      'home-composer-recommendations',
      expect.objectContaining({ defaultJobOptions: { attempts: 3 } }),
    );
    const processor = mockWorkerConstructor.mock.calls[0]?.[1] as (job: {
      data: { userId: string };
    }) => Promise<unknown>;
    await expect(
      processor({ data: { userId: 'private-user-id' } }),
    ).resolves.toBeUndefined();

    const log = String(infoSpy.mock.lastCall?.[0]);
    expect(log).toContain(
      '[home-suggestion-precompute-timing] outcome=generated total_ms=120',
    );
    expect(log).not.toContain('private-user-id');
    expect(log).not.toContain('private suggestion');
    infoSpy.mockRestore();
  });

  it('logs failed generation timing before asking BullMQ to retry', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    mockProcess.mockResolvedValue({
      suggestions: [],
      outcome: 'fallback',
      eligibleReferenceCount: 1,
      readableMemoryCount: 1,
      timing: {
        totalMs: 120_000,
        preferenceGuardMs: 2,
        eligibleReferenceLookupMs: 3,
        cacheStatus: 'miss',
        cacheMs: 1,
        cachedSourceValidationMs: null,
        brainReadsMs: 14,
        helperGenerationMs: 119_975,
        postGenerationValidationMs: null,
      },
    });

    startHomeComposerRecommendationsQueue();
    const processor = mockWorkerConstructor.mock.calls[0]?.[1] as (job: {
      data: { userId: string };
    }) => Promise<unknown>;

    await expect(
      processor({ data: { userId: 'private-user-id' } }),
    ).rejects.toThrow('Home composer recommendation precompute failed');
    expect(String(infoSpy.mock.lastCall?.[0])).toContain(
      'outcome=fallback total_ms=120000',
    );
    infoSpy.mockRestore();
  });
});
