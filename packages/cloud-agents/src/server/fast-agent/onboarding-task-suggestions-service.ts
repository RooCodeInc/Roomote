import { formatErrorForLog } from '@roomote/types';
import { z } from 'zod';

import {
  buildOnboardingTaskSuggestionsObjectPrompt,
  buildOnboardingTaskSuggestionsObjectSystemPrompt,
  buildOnboardingTaskSuggestionsResearchPrompt,
  buildOnboardingTaskSuggestionsResearchSystemPrompt,
} from './onboarding-task-suggestions-prompt';
import {
  generateTrackedNonTaskObject,
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '../non-task-provider-usage';

const ONBOARDING_TASK_SUGGESTION_COUNT = 4;

const onboardingTaskSuggestionBatchSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .describe('A non-empty title of at most 120 characters.'),
            brief: z
              .string()
              .trim()
              .describe('A non-empty brief of at most 4,000 characters.'),
          })
          .strict(),
      )
      .describe(
        `Exactly ${ONBOARDING_TASK_SUGGESTION_COUNT} task suggestions.`,
      ),
  })
  .strict()
  .superRefine(({ suggestions }, context) => {
    if (suggestions.length !== ONBOARDING_TASK_SUGGESTION_COUNT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestions'],
        message: `Exactly ${ONBOARDING_TASK_SUGGESTION_COUNT} suggestions are required.`,
      });
    }

    suggestions.forEach((suggestion, index) => {
      if (suggestion.title.length === 0 || suggestion.title.length > 120) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suggestions', index, 'title'],
          message: 'Title must contain 1 to 120 characters.',
        });
      }
      if (suggestion.brief.length === 0 || suggestion.brief.length > 4_000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suggestions', index, 'brief'],
          message: 'Brief must contain 1 to 4,000 characters.',
        });
      }
    });
  });

const ONBOARDING_SUGGESTION_BRIEF_LABELS = [
  'Goal',
  'Why it matters',
  'Scope',
  'Success criteria',
] as const;

const ONBOARDING_SUGGESTION_BRIEF_SECTION_PATTERN = new RegExp(
  `\\s*(${ONBOARDING_SUGGESTION_BRIEF_LABELS.map((label) =>
    label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
  ).join('|')}):`,
  'gi',
);

function toCanonicalBriefLabel(label: string): string {
  const normalized = label.trim().toLowerCase();

  switch (normalized) {
    case 'goal':
      return 'Goal';
    case 'why it matters':
      return 'Why it matters';
    case 'scope':
      return 'Scope';
    case 'success criteria':
      return 'Success criteria';
    default:
      return label.trim();
  }
}

function normalizeOnboardingSuggestionBrief(brief: string): string {
  const normalizedNewlines = brief.replace(/\r\n?/g, '\n').trim();
  let sectionCount = 0;

  return normalizedNewlines.replace(
    ONBOARDING_SUGGESTION_BRIEF_SECTION_PATTERN,
    (_match, rawLabel: string, offset: number) => {
      const prefix = sectionCount === 0 && offset === 0 ? '' : '\n';
      sectionCount += 1;

      return `${prefix}${toCanonicalBriefLabel(rawLabel)}:`;
    },
  );
}

export type GeneratedOnboardingTaskSuggestion = {
  title: string;
  brief: string;
};

export async function generateOnboardingTaskSuggestions({
  userId,
  repositoryFullNames,
  setupGuidance,
  apiBaseUrl: _apiBaseUrl,
}: {
  userId: string;
  repositoryFullNames: string[];
  setupGuidance: string | null;
  apiBaseUrl?: string;
}): Promise<GeneratedOnboardingTaskSuggestion[] | null> {
  if (repositoryFullNames.length === 0) {
    return [];
  }

  try {
    const repositoryResearch = await generateTrackedNonTaskText({
      userId,
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentOnboardingSuggestions,
      system: buildOnboardingTaskSuggestionsResearchSystemPrompt({
        repositoryFullNames,
      }),
      prompt: buildOnboardingTaskSuggestionsResearchPrompt({
        repositoryFullNames,
        setupGuidance,
      }),
    });

    const { object } = await generateTrackedNonTaskObject({
      userId,
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentOnboardingSuggestions,
      schema: onboardingTaskSuggestionBatchSchema,
      system: buildOnboardingTaskSuggestionsObjectSystemPrompt(),
      prompt: buildOnboardingTaskSuggestionsObjectPrompt({
        repositoryFullNames,
        setupGuidance,
        repositoryResearch,
      }),
    });

    return object.suggestions.map((suggestion) => ({
      title: suggestion.title.trim(),
      brief: normalizeOnboardingSuggestionBrief(suggestion.brief),
    }));
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to generate onboarding task suggestions: ${formatErrorForLog(
        error,
      )}`,
    );
    return null;
  }
}
