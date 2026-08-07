import zodToJsonSchema from 'zod-to-json-schema';

const { mockGenerateTrackedNonTaskObject, mockGenerateTrackedNonTaskText } =
  vi.hoisted(() => ({
    mockGenerateTrackedNonTaskObject: vi.fn(),
    mockGenerateTrackedNonTaskText: vi.fn(),
  }));

vi.mock('../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
    generateTrackedNonTaskText: mockGenerateTrackedNonTaskText,
  };
});

import { generateOnboardingTaskSuggestions } from '../fast-agent/onboarding-task-suggestions-service';

describe('generateOnboardingTaskSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateTrackedNonTaskText.mockResolvedValue('Repository research');
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { suggestions: [] },
    });
  });

  it('keeps wire constraints out of the schema while preserving validation', async () => {
    await generateOnboardingTaskSuggestions({
      userId: 'user-1',
      repositoryFullNames: ['RooCodeInc/Roomote'],
      setupGuidance: null,
    });

    const schema = mockGenerateTrackedNonTaskObject.mock.calls[0]?.[0]?.schema;
    expect(schema).toBeDefined();

    const suggestion = {
      title: 'Investigate retries',
      brief: 'Review retry behavior.',
    };
    expect(
      schema.safeParse({
        suggestions: Array.from({ length: 4 }, () => suggestion),
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ suggestions: [suggestion] }).success).toBe(false);
    expect(
      schema.safeParse({
        suggestions: Array.from({ length: 4 }, () => ({
          title: ' ',
          brief: 'Review retry behavior.',
        })),
      }).success,
    ).toBe(false);

    const wireSchema = zodToJsonSchema(schema, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    });
    expect(JSON.stringify(wireSchema)).not.toMatch(
      /"(?:minItems|maxItems|minLength|maxLength|minimum|maximum|exclusiveMinimum|exclusiveMaximum)"/,
    );
  });
});
