const { mockGenerateTrackedNonTaskObject } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

vi.mock('../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

import { suggestSlackQuestionChannels } from '../slack-question-channel-suggestions';

describe('suggestSlackQuestionChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the valid suggested channels in model order', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        suggestedChannelIds: ['CQUESTIONS', 'CGENERAL', 'CQUESTIONS', 'C404'],
      },
    });

    const channels = await suggestSlackQuestionChannels({
      channels: [
        { id: 'CGENERAL', name: 'general' },
        { id: 'CQUESTIONS', name: 'eng-questions' },
        { id: 'CPLATFORM', name: 'platform' },
      ],
    });

    expect(channels).toEqual([
      { id: 'CQUESTIONS', name: 'eng-questions' },
      { id: 'CGENERAL', name: 'general' },
    ]);
  });

  it('passes channel-pattern guidance and the full public channel list to the model', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        suggestedChannelIds: ['CGENERAL'],
      },
    });

    await suggestSlackQuestionChannels({
      channels: [
        { id: 'CGENERAL', name: 'general' },
        { id: 'CAMA', name: 'ama-eng' },
        { id: 'CQUESTIONS', name: 'questions-backend' },
      ],
    });

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('ask-*'),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('ama-*'),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('- CGENERAL | #general'),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('- CAMA | #ama-eng'),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('- CQUESTIONS | #questions-backend'),
      }),
    );
  });

  it('falls back to #general when the LLM call fails', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValue(
      new Error('OpenCode unavailable'),
    );

    const channels = await suggestSlackQuestionChannels({
      channels: [
        { id: 'CRANDOM', name: 'random' },
        { id: 'CGENERAL', name: 'general' },
      ],
    });

    expect(channels).toEqual([{ id: 'CGENERAL', name: 'general' }]);
  });

  it('returns no suggestions when fallback generation fails and #general is absent', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValue(
      new Error('OpenCode unavailable'),
    );

    const channels = await suggestSlackQuestionChannels({
      channels: [
        { id: 'CRANDOM', name: 'random' },
        { id: 'CSOCIAL', name: 'watercooler' },
      ],
    });

    expect(channels).toEqual([]);
  });
});
