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
  finalizeGeneratedTaskTitle,
  generateLlmTaskTitle,
  generateLlmTaskTitleWithIcon,
  isFallbackTaskTitle,
  TELEGRAM_TOPIC_ICON_EMOJIS,
  telegramTopicIconEmojiSchema,
} from '../llm-task-title';

describe('llm-task-title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
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

  it.each(TELEGRAM_TOPIC_ICON_EMOJIS)(
    'accepts the %s Telegram topic icon',
    (iconEmoji) => {
      expect(telegramTopicIconEmojiSchema.parse(iconEmoji)).toBe(iconEmoji);
    },
  );

  it('omits invalid and missing Telegram topic icons', () => {
    expect(telegramTopicIconEmojiSchema.parse('unexpected')).toBeUndefined();
    expect(telegramTopicIconEmojiSchema.parse(undefined)).toBeUndefined();
  });

  it('returns a validated Telegram topic icon with the generated title', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { title: 'Fix deploy failures', iconEmoji: '🦠' },
    });

    await expect(
      generateLlmTaskTitleWithIcon({
        messages: [{ role: 'user', text: 'Fix the failing deployment.' }],
      }),
    ).resolves.toEqual({ title: 'Fix deploy failures', iconEmoji: '🦠' });
  });

  it('uses a confident judgment-model icon from the supported inventory', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { title: 'Document deployment setup', iconEmoji: '💻' },
    });
    mockEvaluateTypeSafeJudgments.mockResolvedValue({
      icon: {
        type: 'choice',
        choice: 'icon37',
        probabilities: { icon37: 0.96 },
        confidence: 0.96,
      },
    });

    await expect(
      generateLlmTaskTitleWithIcon({
        messages: [
          { role: 'user', text: 'Update the deployment documentation.' },
        ],
      }),
    ).resolves.toEqual({
      title: 'Document deployment setup',
      iconEmoji: '📚',
    });
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledWith({
      state: {
        generatedTitle: 'Document deployment setup',
        conversationTranscript:
          'Conversation transcript (speaker-labeled):\n[User] Update the deployment documentation.\n',
      },
      questions: {
        icon: expect.objectContaining({
          type: 'choice',
          criteria: expect.objectContaining({
            icon37: '📚 (documentation or books) is the best fit.',
          }),
        }),
      },
    });
    const question =
      mockEvaluateTypeSafeJudgments.mock.calls[0]![0].questions.icon;
    expect(Object.keys(question.criteria)).toHaveLength(112);
  });

  it.each([
    ['unconfigured', null],
    [
      'uncertain',
      {
        icon: {
          type: 'choice',
          choice: 'icon37',
          probabilities: { icon37: 0.45 },
          confidence: 0.45,
        },
      },
    ],
  ])(
    'keeps the title-model icon when judgment is %s',
    async (_scenario, judgment) => {
      mockGenerateTrackedNonTaskObject.mockResolvedValue({
        object: { title: 'Fix deploy failures', iconEmoji: '🦠' },
      });
      mockEvaluateTypeSafeJudgments.mockResolvedValue(judgment);

      await expect(
        generateLlmTaskTitleWithIcon({
          messages: [{ role: 'user', text: 'Fix the failing deployment.' }],
        }),
      ).resolves.toEqual({ title: 'Fix deploy failures', iconEmoji: '🦠' });
    },
  );

  it.each([
    ['unavailable', new Error('Judgment model request failed with HTTP 503')],
    [
      'invalid',
      new Error('Judgment model response is missing a valid answer for "icon"'),
    ],
  ])(
    'keeps the title-model icon when judgment is %s',
    async (_scenario, error) => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      mockGenerateTrackedNonTaskObject.mockResolvedValue({
        object: { title: 'Fix deploy failures', iconEmoji: '🦠' },
      });
      mockEvaluateTypeSafeJudgments.mockRejectedValue(error);

      await expect(
        generateLlmTaskTitleWithIcon({
          messages: [{ role: 'user', text: 'Fix the failing deployment.' }],
        }),
      ).resolves.toEqual({ title: 'Fix deploy failures', iconEmoji: '🦠' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Judgment model failed, using title-model selection',
        ),
      );
      warn.mockRestore();
    },
  );

  it.each([undefined, 'unexpected'])(
    'omits model icon %s instead of substituting a generic icon',
    async (iconEmoji) => {
      mockGenerateTrackedNonTaskObject.mockResolvedValue({
        object: { title: 'Plan quarterly priorities', iconEmoji },
      });

      await expect(
        generateLlmTaskTitleWithIcon({
          messages: [{ role: 'user', text: 'Plan quarterly priorities.' }],
        }),
      ).resolves.toEqual({
        title: 'Plan quarterly priorities',
        iconEmoji: undefined,
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
          '🦠 bug or infection, 💬 conversation or messaging',
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

  it('treats a question-shaped user message as title source material', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        title: 'Investigate deployment timing',
      },
    });

    await generateLlmTaskTitle({
      messages: [{ role: 'user', text: 'When was the latest deployment?' }],
    });

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'never answer or reply to the user; when the user asks a question, title its subject or investigation instead',
        ),
        prompt:
          'Conversation transcript (speaker-labeled):\n[User] When was the latest deployment?\n',
      }),
    );
  });
});
