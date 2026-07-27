import { resolveScheduledSuggestionSlackConfig } from '../background-automation-slack';
import {
  buildDeterministicScheduledSuggestionSummary,
  buildScheduledSuggestionRootMessage,
  usesDeterministicScheduledSuggestionRootSummary,
  type RootSummarySuggestion,
} from '../scheduled-suggestion-root-summary';

const { mockGenerateTrackedNonTaskText } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskText: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/non-task-provider-usage', () => ({
  generateTrackedNonTaskText: mockGenerateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES: {
    taskSummaryGeneration: 'task_summary_generation',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildManagerAutomationRootSummaryPromptContract: vi.fn(
    () => 'SUMMARY CONTRACT',
  ),
}));

function buildSuggestions(count: number): RootSummarySuggestion[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Suggestion ${index + 1}`,
    brief: `Brief ${index + 1}`,
    category: 'bug',
    targetRepositoryFullName: 'roo/repo',
  }));
}

describe('usesDeterministicScheduledSuggestionRootSummary', () => {
  it('is deterministic for the suggester', () => {
    expect(
      usesDeterministicScheduledSuggestionRootSummary(
        resolveScheduledSuggestionSlackConfig('suggest_ideas'),
      ),
    ).toBe(true);
  });

  it('is deterministic when no suggestion source is provided', () => {
    expect(
      usesDeterministicScheduledSuggestionRootSummary(
        resolveScheduledSuggestionSlackConfig(undefined),
      ),
    ).toBe(true);
  });

  it('keeps the generated summary for other automations', () => {
    expect(
      usesDeterministicScheduledSuggestionRootSummary(
        resolveScheduledSuggestionSlackConfig('sentry_triage'),
      ),
    ).toBe(false);
  });
});

describe('buildDeterministicScheduledSuggestionSummary', () => {
  it('lists the top titles and counts the overflow in the thread', () => {
    const summary = buildDeterministicScheduledSuggestionSummary({
      slackConfig: resolveScheduledSuggestionSlackConfig('suggest_ideas'),
      suggestions: buildSuggestions(5),
    });

    expect(summary).toBe(
      [
        'Suggested follow-up work:',
        '- Suggestion 1\n- Suggestion 2\n- Suggestion 3\n- 2 more suggestions in the thread',
      ].join('\n\n'),
    );
  });

  it('omits the overflow line when every title fits', () => {
    const summary = buildDeterministicScheduledSuggestionSummary({
      slackConfig: resolveScheduledSuggestionSlackConfig('suggest_ideas'),
      suggestions: buildSuggestions(2),
    });

    expect(summary).not.toContain('more suggestion');
    expect(summary).toContain('- Suggestion 1\n- Suggestion 2');
  });
});

describe('buildScheduledSuggestionRootMessage', () => {
  beforeEach(() => {
    mockGenerateTrackedNonTaskText.mockReset();
  });

  it('never calls the model for suggester runs and composes the parent note from the structured submission', async () => {
    const slackConfig = resolveScheduledSuggestionSlackConfig('suggest_ideas');
    const suggestions = buildSuggestions(5);

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions,
    });

    expect(mockGenerateTrackedNonTaskText).not.toHaveBeenCalled();
    expect(rootMessage).toEqual({
      summaryText: buildDeterministicScheduledSuggestionSummary({
        slackConfig,
        suggestions,
      }),
      actionFooterText: slackConfig.actionFooterText,
    });
  });

  it('keeps the generated summary for non-suggester automations', async () => {
    mockGenerateTrackedNonTaskText.mockResolvedValue('Generated summary');
    const slackConfig = resolveScheduledSuggestionSlackConfig('sentry_triage');

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions: buildSuggestions(2),
    });

    expect(mockGenerateTrackedNonTaskText).toHaveBeenCalledTimes(1);
    expect(rootMessage.summaryText).toBe('Generated summary');
  });

  it('falls back to the deterministic summary when generation fails', async () => {
    mockGenerateTrackedNonTaskText.mockRejectedValue(new Error('model down'));
    const slackConfig = resolveScheduledSuggestionSlackConfig('sentry_triage');
    const suggestions = buildSuggestions(4);

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions,
    });

    expect(rootMessage.summaryText).toBe(
      buildDeterministicScheduledSuggestionSummary({
        slackConfig,
        suggestions,
      }),
    );
  });

  it('falls back to the deterministic summary when generation returns only whitespace', async () => {
    mockGenerateTrackedNonTaskText.mockResolvedValue('   \n  ');
    const slackConfig = resolveScheduledSuggestionSlackConfig('sentry_triage');
    const suggestions = buildSuggestions(1);

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions,
    });

    expect(rootMessage.summaryText).toBe(
      buildDeterministicScheduledSuggestionSummary({
        slackConfig,
        suggestions,
      }),
    );
  });
});
