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

type SuggestionBadgeStyle = 'full' | 'color_only';

type SuggestionSlackTextOptions = {
  badgeStyle?: SuggestionBadgeStyle;
  quote?: boolean;
};

type SuggestionSeededTextOptions = {
  statusLabel?: 'started' | 'accepted';
};

const SHARED_SCHEDULED_SUGGESTION_AGENT_TYPES = new Set(['suggested_tasks']);

export function usesSharedScheduledSuggestionSlackModel(
  agentType?: string | null,
): boolean {
  return (
    typeof agentType === 'string' &&
    SHARED_SCHEDULED_SUGGESTION_AGENT_TYPES.has(agentType)
  );
}

export function getSharedScheduledSuggestionSlackTextOptions(
  agentType?: string | null,
): SuggestionSlackTextOptions | undefined {
  if (!usesSharedScheduledSuggestionSlackModel(agentType)) {
    return undefined;
  }

  return {
    badgeStyle: 'color_only',
    quote: true,
  };
}

export function getSharedScheduledSuggestionSeededTextOptions(
  agentType?: string | null,
): SuggestionSeededTextOptions | undefined {
  if (!usesSharedScheduledSuggestionSlackModel(agentType)) {
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
    category?: string | null;
    priority?: string | null;
    targetRepositoryFullName?: string | null;
    footerText?: string | null;
  },
  options: SuggestionSlackTextOptions = {},
): string {
  const repoLabel = params.targetRepositoryFullName
    ? ` [${params.targetRepositoryFullName}](https://github.com/${params.targetRepositoryFullName})`
    : '';

  const prefix = buildSuggestionBadgePrefix(
    {
      category: params.category,
      priority: params.priority,
    },
    { style: options.badgeStyle },
  );

  const text = [
    `**${prefix}${params.title}**${repoLabel}`,
    params.brief,
    params.footerText?.trim() || null,
  ]
    .filter(Boolean)
    .join('\n');

  return options.quote ? quoteSlackMarkdown(text) : text;
}

export function buildSuggestionBadgePrefix(
  params: {
    category?: string | null;
    priority?: string | null;
  },
  options: { style?: SuggestionBadgeStyle } = {},
): string {
  const badges: string[] = [];
  const badgeStyle = options.style ?? 'full';

  if (params.priority && suggestionPrioritySet.has(params.priority)) {
    const priority = params.priority as SuggestionPriority;
    badges.push(
      badgeStyle === 'color_only'
        ? SUGGESTION_PRIORITY_EMOJIS[priority]
        : `${SUGGESTION_PRIORITY_EMOJIS[priority]} [${SUGGESTION_PRIORITY_LABELS[priority]}]`,
    );
  }

  if (params.category && suggestionCategorySet.has(params.category)) {
    const category = params.category as SuggestionCategory;
    badges.push(
      badgeStyle === 'color_only'
        ? `[${SUGGESTION_CATEGORY_LABELS[category]}]`
        : `${SUGGESTION_CATEGORY_EMOJIS[category]} [${SUGGESTION_CATEGORY_LABELS[category]}]`,
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
