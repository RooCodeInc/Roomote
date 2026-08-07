import {
  type SuggestionCategory,
  suggestionCategorySet,
  SUGGESTION_CATEGORY_EMOJIS,
  SUGGESTION_CATEGORY_LABELS,
  type SuggestionPriority,
  suggestionPrioritySet,
  SUGGESTION_PRIORITY_EMOJIS,
  SUGGESTION_PRIORITY_LABELS,
} from '@roomote/types';

type SuggestionSlackTextOptions = {
  quote?: boolean;
};

type SuggestionSeededTextOptions = {
  statusLabel?: 'started' | 'accepted';
};

const SHARED_SCHEDULED_SUGGESTION_TYPES = new Set(['suggested_tasks']);

export function usesSharedScheduledSuggestionSlackModel(
  suggestionType?: string | null,
): boolean {
  return (
    typeof suggestionType === 'string' &&
    SHARED_SCHEDULED_SUGGESTION_TYPES.has(suggestionType)
  );
}

export function getSharedScheduledSuggestionSlackTextOptions(
  suggestionType?: string | null,
): SuggestionSlackTextOptions | undefined {
  if (!usesSharedScheduledSuggestionSlackModel(suggestionType)) {
    return undefined;
  }

  return {
    quote: true,
  };
}

export function getSharedScheduledSuggestionSeededTextOptions(
  suggestionType?: string | null,
): SuggestionSeededTextOptions | undefined {
  if (!usesSharedScheduledSuggestionSlackModel(suggestionType)) {
    return undefined;
  }

  return {
    statusLabel: 'accepted',
  };
}

export function buildSuggestionSlackText(
  params: {
    title: string;
    brief: string;
    footerText?: string | null;
  },
  options: SuggestionSlackTextOptions = {},
): string {
  const text = [
    `**${params.title}**`,
    params.brief,
    params.footerText?.trim() || null,
  ]
    .filter(Boolean)
    .join('\n');

  return options.quote ? quoteSlackMarkdown(text) : text;
}

export function buildSuggestionBadgePrefix(params: {
  category?: string | null;
  priority?: string | null;
}): string {
  const badges: string[] = [];

  if (params.priority && suggestionPrioritySet.has(params.priority)) {
    const priority = params.priority as SuggestionPriority;
    badges.push(
      `${SUGGESTION_PRIORITY_EMOJIS[priority]} [${SUGGESTION_PRIORITY_LABELS[priority]}]`,
    );
  }

  if (params.category && suggestionCategorySet.has(params.category)) {
    const category = params.category as SuggestionCategory;
    badges.push(
      `${SUGGESTION_CATEGORY_EMOJIS[category]} [${SUGGESTION_CATEGORY_LABELS[category]}]`,
    );
  }

  return badges.length > 0 ? `${badges.join(' ')} ` : '';
}

export function buildSeededSuggestionSlackText(
  baseText: string,
  initiatingSlackUserId?: string,
  options: SuggestionSeededTextOptions = {},
): string {
  const slackUserId = initiatingSlackUserId?.trim();

  if (!slackUserId) {
    return baseText;
  }

  const statusText =
    options.statusLabel === 'accepted'
      ? `Accepted by <@${slackUserId}>`
      : `Started by <@${slackUserId}>.`;

  return `${baseText}\n\n${statusText}`;
}

function quoteSlackMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
