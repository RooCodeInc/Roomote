const { mockGenerateTrackedNonTaskObject, mockEvaluateTypeSafeJudgments } =
  vi.hoisted(() => ({
    mockGenerateTrackedNonTaskObject: vi.fn(),
    mockEvaluateTypeSafeJudgments: vi.fn(),
  }));

vi.mock('../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

vi.mock('../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

import {
  selectDiscordForumTag,
  type DiscordForumTagCandidate,
} from '../discord-forum-tag';

const tags: DiscordForumTagCandidate[] = [
  {
    id: 'tag-bug',
    name: 'Bug',
  },
  {
    id: 'tag-docs',
    name: 'Documentation',
  },
];

describe('selectDiscordForumTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
  });

  it('returns the router-selected available tag', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: {
        tagId: 'tag-docs',
        reasoning: 'The task asks to update the setup guide.',
      },
    });

    await expect(
      selectDiscordForumTag({
        taskDescription: 'Update the installation guide for macOS.',
        availableTags: tags,
        tracking: { userId: 'user-1' },
      }),
    ).resolves.toEqual({
      tagId: 'tag-docs',
      reasoning: 'The task asks to update the setup guide.',
    });
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        surface: 'router_discord_forum_tag',
        timeoutMs: 15_000,
      }),
    );
  });

  it('uses the only available tag without calling the model', async () => {
    await expect(
      selectDiscordForumTag({
        taskDescription: 'Fix the build.',
        availableTags: [tags[0]!],
      }),
    ).resolves.toEqual({
      tagId: 'tag-bug',
      reasoning: 'Only one forum tag is available.',
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('returns null when the router selects an unavailable tag', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: { tagId: 'tag-other', reasoning: 'No valid match.' },
    });

    await expect(
      selectDiscordForumTag({
        taskDescription: 'Fix the build.',
        availableTags: tags,
      }),
    ).resolves.toBeNull();
  });

  it('returns null when routing fails so the provider can use its fallback', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('router unavailable'),
    );

    await expect(
      selectDiscordForumTag({
        taskDescription: 'Fix the build.',
        availableTags: tags,
      }),
    ).resolves.toBeNull();
  });

  describe('with the judgment model', () => {
    function mockJudgment(choice: string, confidence: number) {
      mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
        tag: {
          type: 'choice',
          choice,
          probabilities: { [choice]: confidence },
          confidence,
        },
      });
    }

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('uses a confident pick without calling the helper model', async () => {
      mockJudgment('tag1', 0.97);

      await expect(
        selectDiscordForumTag({
          taskDescription: 'Update the installation guide for macOS.',
          availableTags: tags,
        }),
      ).resolves.toEqual({
        tagId: 'tag-docs',
        reasoning: 'Judgment model: best-fitting tag (confidence=0.97).',
      });
      expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledWith(
        expect.objectContaining({
          state: {
            taskDescription: 'Update the installation guide for macOS.',
            availableTags: ['Bug', 'Documentation'],
          },
        }),
      );
      expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
    });

    it('falls back to the helper model when the pick is not confident', async () => {
      mockJudgment('tag0', 0.45);
      mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
        object: { tagId: 'tag-docs', reasoning: 'Docs work.' },
      });

      await expect(
        selectDiscordForumTag({
          taskDescription: 'Clean things up a bit.',
          availableTags: tags,
        }),
      ).resolves.toEqual({ tagId: 'tag-docs', reasoning: 'Docs work.' });
      expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(1);
    });

    it('falls back to the helper model when the judgment model fails', async () => {
      mockEvaluateTypeSafeJudgments.mockRejectedValueOnce(
        new Error('TypeSafe request failed with HTTP 503'),
      );
      mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
        object: { tagId: 'tag-bug', reasoning: 'A crash.' },
      });

      await expect(
        selectDiscordForumTag({
          taskDescription: 'The login page crashes.',
          availableTags: tags,
        }),
      ).resolves.toEqual({ tagId: 'tag-bug', reasoning: 'A crash.' });
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
