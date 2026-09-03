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
});
