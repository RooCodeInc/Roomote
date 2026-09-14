import type { UserAuthSuccess } from '@/types';

const { mockGetRecommendations, mockLoggerInfo } = vi.hoisted(() => ({
  mockGetRecommendations: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  getHomeComposerRecommendations: mockGetRecommendations,
}));

vi.mock('@/lib/server/logger', () => ({
  logger: { info: mockLoggerInfo },
}));

import { getHomeComposerSuggestionsCommand } from './composer-suggestions';

const auth = { userId: 'user-1' } as UserAuthSuccess;
const timing = {
  totalMs: 12,
  preferenceGuardMs: 1,
  eligibleReferenceLookupMs: 2,
  cacheMs: 3,
  cacheStatus: 'fresh' as const,
  cachedSourceValidationMs: null,
  brainReadsMs: null,
  helperGenerationMs: null,
  postGenerationValidationMs: null,
};
const suggestions = [
  'Add focused regression coverage for authentication callback validation across supported login flows',
  'Fix deployment health check recovery gaps before the next production release',
  'Document authentication callback failure handling for every supported sign-in provider',
  'Review session handoff reliability across interrupted tasks and delayed worker restarts',
  'Improve deployment health check guidance for operators diagnosing repeated recovery failures',
];

describe('getHomeComposerSuggestionsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves the shared recommendation cache and logs privacy-safe timing', async () => {
    mockGetRecommendations.mockResolvedValue({
      suggestions,
      outcome: 'fresh_cache',
      timing,
      eligibleReferenceCount: 5,
      readableMemoryCount: null,
      failureReason: null,
    });

    await expect(getHomeComposerSuggestionsCommand(auth)).resolves.toEqual({
      suggestions,
    });
    expect(mockGetRecommendations).toHaveBeenCalledWith('user-1');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[home-suggestion-timing\] outcome=fresh_cache total_ms=.+ preference_guard_ms=1 eligible_reference_lookup_ms=2 context_cache_status=fresh context_cache_ms=3 cached_source_validation_ms=n\/a brain_reads_ms=n\/a helper_generation_ms=n\/a post_generation_validation_ms=n\/a failure_reason=n\/a eligible_reference_count=5 readable_memory_count=n\/a suggestion_count=5$/u,
      ),
    );

    const logged = String(mockLoggerInfo.mock.lastCall?.[0]);
    expect(logged).not.toContain('user-1');
    for (const suggestion of suggestions)
      expect(logged).not.toContain(suggestion);
  });

  it('returns no suggestions when the shared preference guard is off', async () => {
    mockGetRecommendations.mockResolvedValue({
      suggestions: [],
      outcome: 'flag_disabled',
      timing: {
        ...timing,
        cacheStatus: 'not_checked',
        eligibleReferenceLookupMs: null,
        cacheMs: null,
      },
      eligibleReferenceCount: null,
      readableMemoryCount: null,
      failureReason: null,
    });

    await expect(getHomeComposerSuggestionsCommand(auth)).resolves.toEqual({
      suggestions: [],
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('outcome=flag_disabled'),
    );
  });

  it('fails soft when the shared service is unavailable', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetRecommendations.mockRejectedValue(new Error('unavailable'));

    await expect(getHomeComposerSuggestionsCommand(auth)).resolves.toEqual({
      suggestions: [],
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('outcome=error'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('logs the shared failure stage without exposing request context', async () => {
    mockGetRecommendations.mockResolvedValue({
      suggestions: [],
      outcome: 'fallback',
      timing,
      eligibleReferenceCount: 5,
      readableMemoryCount: 5,
      failureReason: 'cache_write_error',
    });

    await expect(getHomeComposerSuggestionsCommand(auth)).resolves.toEqual({
      suggestions: [],
    });
    const logged = String(mockLoggerInfo.mock.lastCall?.[0]);
    expect(logged).toContain('failure_reason=cache_write_error');
    expect(logged).not.toContain('user-1');
  });

  it('preserves the response when timing logging fails', async () => {
    mockGetRecommendations.mockResolvedValue({
      suggestions: [],
      outcome: 'no_eligible_memories',
      timing,
      eligibleReferenceCount: 0,
      readableMemoryCount: null,
      failureReason: null,
    });
    mockLoggerInfo.mockImplementationOnce(() => {
      throw new Error('log unavailable');
    });

    await expect(getHomeComposerSuggestionsCommand(auth)).resolves.toEqual({
      suggestions: [],
    });
  });
});
