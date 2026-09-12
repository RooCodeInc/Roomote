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
  finalizeGeneratedTaskTitle,
  generateLlmTaskTitle,
  generateLlmTaskTitleWithCategory,
  isFallbackTaskTitle,
  TASK_TITLE_CATEGORIES,
  taskTitleCategorySchema,
} from '../llm-task-title';

describe('llm-task-title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces a maximum of 12 words', () => {
    const title = finalizeGeneratedTaskTitle(
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    );

    expect(title).toBe(
      'one two three four five six seven eight nine ten eleven twelve',
    );
  });

  it('does not append any source suffix to generated titles', () => {
    const title = finalizeGeneratedTaskTitle(
      'one two three four five six seven eight nine ten eleven',
    );

    expect(title).toBe(
      'one two three four five six seven eight nine ten eleven',
    );
  });

  it('recognizes the fallback title after sanitization', () => {
    expect(isFallbackTaskTitle('   ""   ')).toBe(true);
    expect(isFallbackTaskTitle('Untitled task')).toBe(true);
    expect(isFallbackTaskTitle('Investigate worker boot loops')).toBe(false);
  });

  it.each(TASK_TITLE_CATEGORIES)(
    'accepts the %s title category',
    (category) => {
      expect(taskTitleCategorySchema.parse(category)).toBe(category);
    },
  );

  it('normalizes invalid and missing categories to general', () => {
    expect(taskTitleCategorySchema.parse('unexpected')).toBe('general');
    expect(taskTitleCategorySchema.parse(undefined)).toBe('general');
  });

  it('returns a validated category with the generated title', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { title: 'Fix deploy failures', category: 'fix' },
    });

    await expect(
      generateLlmTaskTitleWithCategory({
        messages: [{ role: 'user', text: 'Fix the failing deployment.' }],
      }),
    ).resolves.toEqual({ title: 'Fix deploy failures', category: 'fix' });
  });

  it.each([undefined, 'unexpected'])(
    'falls back to general for model category %s',
    async (category) => {
      mockGenerateTrackedNonTaskObject.mockResolvedValue({
        object: { title: 'Plan quarterly priorities', category },
      });

      await expect(
        generateLlmTaskTitleWithCategory({
          messages: [{ role: 'user', text: 'Plan quarterly priorities.' }],
        }),
      ).resolves.toEqual({
        title: 'Plan quarterly priorities',
        category: 'general',
      });
    },
  );

  it('falls back to a sanitized default title on malformed model output', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        title: '   ""   ',
      },
    });

    const title = await generateLlmTaskTitle({
      messages: [
        { role: 'user', text: 'Please investigate worker boot loops.' },
        { role: 'assistant', text: 'I am checking startup logs now.' },
      ],
    });

    expect(title).toBe('Untitled task');
  });

  it('passes user-led intent guidance and clear role labels to the model', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        title: 'Fix deploy title casing',
      },
    });

    await generateLlmTaskTitle({
      messages: [
        { role: 'user', text: 'Start by reviewing the deploy issue.' },
        {
          role: 'assistant',
          text: 'I found the rollback cause and I am checking the title flow.',
        },
        {
          role: 'user',
          text: 'Please update the task title prompt to use sentence case.',
        },
      ],
    });

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'general, security, fix, test, release, docs, ui, data, communication',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'base the title on the full conversation as it evolves',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'preserve proper nouns, acronyms, and file names, capitalize the first word',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          "use user messages as the primary source for the task's intention",
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'never assert an outcome or failure state such as failed, blocked, stuck, or missing unless the final message explicitly states that outcome',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'use assistant messages only to complement, clarify, or sharpen the user',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Conversation transcript (speaker-labeled):',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '[User] Start by reviewing the deploy issue.',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '[Assistant] I found the rollback cause and I am checking the title flow.',
        ),
      }),
    );
  });
});
