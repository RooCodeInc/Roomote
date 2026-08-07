import type { Context } from 'hono';
import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  getCommunicationChannelFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type TaskPayload,
  TaskPayloadKind,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  supportsHistoricalThreadFeedback,
  normalizeSetupNewState,
  SUGGESTION_PRIORITY_EMOJIS,
  type SuggestionCategory,
  type SuggestionPriority,
  type TaskSuggestionSource,
  suggestionCategorySet,
  suggestionPrioritySet,
  workspaceReadinessSchema,
  type WorkspaceReadiness,
} from '@roomote/types';
import { SlackNotifier } from '@roomote/slack';
import { SETUP_SUGGESTIONS_THREAD_INTRO_TEXT } from '@roomote/communication/chat-messages';
import { findEnvironmentForRepo } from '@roomote/cloud-agents/server';
import {
  buildAutomationRootSummaryMessage,
  buildAutomationRootSummaryText,
  enqueueSlackSuggestedTasksOnboardingFollowup,
  shouldPostHistoricalThreadFeedbackDebugSnippet,
} from '@roomote/sdk/server';
import {
  and,
  asc,
  buildTaskSuggestionContentHash,
  db,
  environments,
  eq,
  inArray,
  repositories,
  resolveRepositorySelectionByIds,
  slackInstallationChannels,
  slackInstallations,
  slackUserMappings,
  sql,
  taskRuns,
  tasks,
  trackedMessages,
  upsertBackgroundAutomationSlackThread,
  workItems,
  getAutomationRuntime,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import { apiLogger } from '../../logging';
import type { McpAuth } from '../mcp/middleware';
import {
  buildSuggestionSlackText,
  getSharedScheduledSuggestionSlackTextOptions,
  usesSharedScheduledSuggestionSlackModel,
} from '../slack/helpers/suggestion-workspace';
import { resolveScheduledSuggestionSlackConfig } from './background-automation-slack';
import { buildScheduledSuggestionRootMessage } from './scheduled-suggestion-root-summary';
import {
  scheduleSuggestedTasksFollowupBestEffort,
  SETUP_ONBOARDING_SUGGESTION_TYPE,
} from './setup-suggestion-lifecycle';
import {
  postCurrentThreadSuggestionsToTelegram,
  postScheduledSuggestionsToTelegram,
} from '../telegram/automation-suggestions';
import {
  postCurrentThreadSuggestionsToTeams,
  postScheduledSuggestionsToTeams,
} from '../teams/automation-suggestions';
import {
  postCurrentThreadSuggestionsToDiscord,
  postScheduledSuggestionsToDiscord,
} from '../discord/automation-suggestions';
import { postSetupTaskSuggestionsToDiscord } from '../discord/setup-suggestions';
import { postSetupTaskSuggestionsToTelegram } from '../telegram/setup-suggestions';
import { postSetupTaskSuggestionsToTeams } from '../teams/setup-suggestions';
import { logHandlerError } from '../utils';

const taskSuggestionSchema = z.object({
  title: z.string().trim().min(1).max(140),
  brief: z.string().trim().min(1).max(2000),
  category: z
    .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
    .optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  investigationContext: z.string().trim().max(4000).optional(),
  targetRepositoryFullName: z.string().trim().min(1).optional(),
  targetEnvironmentId: z.string().uuid().optional(),
  workspaceReadiness: workspaceReadinessSchema.optional(),
  readinessMessage: z.string().trim().min(1).max(500).optional(),
});

const submitTaskSuggestionsBodySchema = z.object({
  suggestions: z.array(taskSuggestionSchema).max(10),
  delivery: z.literal('current_thread').optional(),
  submissionKey: z.string().trim().min(1).max(200).optional(),
});

const SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE =
  'roomote.setup_onboarding_suggestion';

type SuggestedTasksPayload = TaskPayload<typeof TaskPayloadKind.Scan>;

type PersistedTaskSuggestion = {
  id: string;
  title: string;
  brief: string;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: WorkspaceReadiness | null;
  readinessMessage: string | null;
};

/**
 * Suggestion work_items always insert a non-empty brief (the payload requires
 * `min(1)`), but the merged `work_items.brief` column is nullable. Normalize on
 * read so downstream communication-provider formatting keeps a plain string.
 */
function toPersistedTaskSuggestion(row: {
  id: string;
  title: string;
  brief: string | null;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: WorkspaceReadiness | null;
  readinessMessage: string | null;
}): PersistedTaskSuggestion {
  return { ...row, brief: row.brief ?? '' };
}

type ResolvedRepository = {
  id: string;
  fullName: string;
};

type PreparedTaskSuggestion = {
  title: string;
  brief: string;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: WorkspaceReadiness | null;
  readinessMessage: string | null;
};

type TaskSuggestionType =
  | typeof SETUP_ONBOARDING_SUGGESTION_TYPE
  | 'suggested_tasks'
  | 'sentry_triage'
  | 'dependabot_triage'
  | 'codeql_triage'
  | 'security_auditor'
  | 'code_quality_auditor'
  | 'ci_failure_triage';

type SuggestionCardMessageRow = {
  suggestionType: TaskSuggestionType;
  launchRouting?: 'router';
  messageTs: string;
  channelId: string;
  workItemId: string;
  suggestionKey: string;
  createdByUserId: string | null;
};

/**
 * Map Slack suggestion-card rows to `tracked_messages` insert values. The
 * launch state lives on the referenced `work_items` row; the tracked message
 * carries only registry metadata (suggestion type + key) and dedups on
 * `(kind, dedupeKey)` where dedupeKey is `${channelId}:${messageTs}`.
 */
function buildSlackSuggestionCardValues(
  rows: SuggestionCardMessageRow[],
): (typeof trackedMessages.$inferInsert)[] {
  return rows.map((row) => ({
    surface: 'slack' as const,
    kind: 'suggestion_card' as const,
    dedupeKey: `${row.channelId}:${row.messageTs}`,
    channelId: row.channelId,
    messageTs: row.messageTs,
    workItemId: row.workItemId,
    createdByUserId: row.createdByUserId,
    metadata: {
      suggestionType: row.suggestionType,
      suggestionKey: row.suggestionKey,
      ...(row.launchRouting ? { launchRouting: row.launchRouting } : {}),
    },
  }));
}

function buildSuggestionMessageKey(params: {
  sourceTaskId: string;
  suggestionId: string;
}): string {
  return `${params.sourceTaskId}:${params.suggestionId}`;
}

function buildSuggestionMessageMetadata(params: {
  sourceTaskId: string;
  suggestionId: string;
}) {
  return {
    event_type: SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE,
    event_payload: {
      sourceTaskId: params.sourceTaskId,
      suggestionId: params.suggestionId,
      schemaVersion: 1,
    },
  };
}

function buildSuggestedTasksSummaryLockKey(params: {
  sourceTaskId: string;
}): string {
  return `suggested_tasks:${params.sourceTaskId}`;
}

function getSuggestedTaskRepositoryFullNames(
  payload: SuggestedTasksPayload,
): string[] {
  if (payload.repo === ALL_REPOSITORIES) {
    return [...new Set(payload.selectedRepositories ?? [])];
  }

  if (payload.repo?.trim()) {
    return [payload.repo.trim()];
  }

  return [];
}

async function resolveRepositoryIdsForSuggestedTask(params: {
  payload: SuggestedTasksPayload;
}): Promise<ResolvedRepository[]> {
  let repositoryFullNames = getSuggestedTaskRepositoryFullNames(params.payload);

  if (
    params.payload.repo === ALL_REPOSITORIES &&
    repositoryFullNames.length === 0 &&
    !params.payload.environmentId
  ) {
    return db
      .select({ id: repositories.id, fullName: repositories.fullName })
      .from(repositories)
      .where(eq(repositories.isActive, true))
      .orderBy(asc(repositories.fullName));
  }

  if (repositoryFullNames.length === 0 && params.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, params.payload.environmentId),
      columns: { config: true },
    });
    const configuredRepositories =
      environment?.config &&
      typeof environment.config === 'object' &&
      'repositories' in environment.config &&
      Array.isArray(environment.config.repositories)
        ? environment.config.repositories
        : [];
    repositoryFullNames = configuredRepositories
      .map((repository) =>
        typeof repository?.repository === 'string'
          ? repository.repository.trim()
          : '',
      )
      .filter(Boolean);
  }

  if (repositoryFullNames.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(inArray(repositories.fullName, repositoryFullNames));

  const rowsByFullName = new Map(
    rows.map((repository) => [repository.fullName, repository]),
  );

  return repositoryFullNames
    .map((repositoryFullName) => rowsByFullName.get(repositoryFullName))
    .filter((repository): repository is ResolvedRepository =>
      Boolean(repository),
    );
}

async function resolveRepositoriesByIds(params: {
  repositoryIds: string[];
}): Promise<ResolvedRepository[]> {
  const { selectedRepositories } = await resolveRepositorySelectionByIds({
    repositoryIds: params.repositoryIds,
    executor: db,
  });

  return selectedRepositories;
}

function buildDefaultBareRepoReadinessMessage(
  targetRepositoryFullName: string,
): string {
  return `I can inspect and edit \`${targetRepositoryFullName}\`, but full app or service validation may be limited until this repo is added to an environment.`;
}

function buildUnavailableEnvironmentReadinessMessage(
  targetRepositoryFullName: string,
): string {
  return `The saved environment for \`${targetRepositoryFullName}\` is no longer available, so I'll launch this suggestion in bare repo mode.`;
}

function prepareTaskSuggestion(params: {
  suggestion: z.infer<typeof taskSuggestionSchema>;
  candidateRepositorySet: Set<string>;
  environmentsById: Map<string, { id: string; config: unknown }>;
}): PreparedTaskSuggestion {
  const { suggestion, candidateRepositorySet, environmentsById } = params;
  const targetRepositoryFullName =
    suggestion.targetRepositoryFullName?.trim() || null;
  const targetEnvironmentId = suggestion.targetEnvironmentId ?? null;
  const explicitReadiness = suggestion.workspaceReadiness ?? null;
  const readinessMessage = suggestion.readinessMessage?.trim() || null;
  let normalizedTargetEnvironmentId = targetEnvironmentId;
  let normalizedReadinessMessage = readinessMessage;
  let shouldDowngradeToBareRepo = false;

  if (
    targetRepositoryFullName &&
    !candidateRepositorySet.has(targetRepositoryFullName)
  ) {
    throw new Error(
      `Suggestion "${suggestion.title}" targets repository "${targetRepositoryFullName}", which is not part of this suggestion run.`,
    );
  }

  if (targetEnvironmentId && !targetRepositoryFullName) {
    throw new Error(
      `Suggestion "${suggestion.title}" includes targetEnvironmentId without targetRepositoryFullName.`,
    );
  }

  if (!targetRepositoryFullName) {
    if (targetEnvironmentId || explicitReadiness || readinessMessage) {
      throw new Error(
        `Suggestion "${suggestion.title}" must include targetRepositoryFullName when launch metadata is provided.`,
      );
    }

    return {
      title: suggestion.title,
      brief: suggestion.brief,
      category: suggestion.category ?? null,
      priority: suggestion.priority ?? null,
      investigationContext: suggestion.investigationContext?.trim() || null,
      targetRepositoryFullName: null,
      targetEnvironmentId: null,
      workspaceReadiness: null,
      readinessMessage: null,
    } satisfies PreparedTaskSuggestion;
  }

  if (targetEnvironmentId) {
    const environment = environmentsById.get(targetEnvironmentId);

    if (!environment) {
      apiLogger.warn(
        `[submitTaskSuggestions] Suggestion "${suggestion.title}" targets missing environment "${targetEnvironmentId}"; downgrading to bare_repo`,
      );
      normalizedTargetEnvironmentId = null;
      normalizedReadinessMessage = buildUnavailableEnvironmentReadinessMessage(
        targetRepositoryFullName,
      );
      shouldDowngradeToBareRepo = true;
    } else {
      const configuredRepositories =
        environment.config &&
        typeof environment.config === 'object' &&
        'repositories' in environment.config &&
        Array.isArray(environment.config.repositories)
          ? environment.config.repositories
          : [];

      const includesTargetRepository = configuredRepositories.some(
        (repository) =>
          repository?.repository?.toLowerCase?.() ===
          targetRepositoryFullName.toLowerCase(),
      );

      if (!includesTargetRepository) {
        throw new Error(
          `Suggestion "${suggestion.title}" targets environment "${targetEnvironmentId}", but that environment does not include "${targetRepositoryFullName}".`,
        );
      }
    }
  }

  const workspaceReadiness = shouldDowngradeToBareRepo
    ? 'bare_repo'
    : (explicitReadiness ??
      (normalizedTargetEnvironmentId ? 'environment_backed' : 'bare_repo'));

  if (
    workspaceReadiness === 'environment_backed' &&
    !normalizedTargetEnvironmentId
  ) {
    throw new Error(
      `Suggestion "${suggestion.title}" marked as environment_backed is missing targetEnvironmentId.`,
    );
  }

  if (workspaceReadiness === 'bare_repo' && normalizedTargetEnvironmentId) {
    throw new Error(
      `Suggestion "${suggestion.title}" marked as bare_repo cannot also include targetEnvironmentId.`,
    );
  }

  return {
    title: suggestion.title,
    brief: suggestion.brief,
    category: suggestion.category ?? null,
    priority: suggestion.priority ?? null,
    investigationContext: suggestion.investigationContext?.trim() || null,
    targetRepositoryFullName,
    targetEnvironmentId: normalizedTargetEnvironmentId,
    workspaceReadiness,
    readinessMessage:
      workspaceReadiness === 'bare_repo'
        ? (normalizedReadinessMessage ??
          buildDefaultBareRepoReadinessMessage(targetRepositoryFullName))
        : null,
  } satisfies PreparedTaskSuggestion;
}

async function resolvePreparedSuggestions(params: {
  suggestions: z.infer<typeof taskSuggestionSchema>[];
  candidateRepositories: ResolvedRepository[];
  tolerateInvalidSuggestions?: boolean;
}): Promise<PreparedTaskSuggestion[]> {
  const candidateRepositorySet = new Set(
    params.candidateRepositories.map((repository) => repository.fullName),
  );
  const targetEnvironmentIds = [
    ...new Set(
      params.suggestions
        .map((suggestion) => suggestion.targetEnvironmentId)
        .filter(
          (environmentId): environmentId is string =>
            typeof environmentId === 'string',
        ),
    ),
  ];

  const environmentsById =
    targetEnvironmentIds.length === 0
      ? new Map<string, { id: string; config: unknown }>()
      : new Map(
          (
            await db
              .select({
                id: environments.id,
                config: environments.config,
              })
              .from(environments)
              .where(inArray(environments.id, targetEnvironmentIds))
          ).map((environment) => [environment.id, environment]),
        );

  const preparedSuggestions: PreparedTaskSuggestion[] = [];

  for (const suggestion of params.suggestions) {
    try {
      preparedSuggestions.push(
        prepareTaskSuggestion({
          suggestion,
          candidateRepositorySet,
          environmentsById,
        }),
      );
    } catch (error) {
      if (!params.tolerateInvalidSuggestions) {
        throw error;
      }

      apiLogger.warn(
        `[submitTaskSuggestions] Dropping scheduled suggestion "${suggestion.title}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return preparedSuggestions;
}

function prioritizeScheduledSuggestions(
  suggestions: PreparedTaskSuggestion[],
): PreparedTaskSuggestion[] {
  const decorated = suggestions.map((suggestion, index) => ({
    suggestion,
    index,
    rank:
      suggestion.workspaceReadiness === 'environment_backed'
        ? 0
        : suggestion.workspaceReadiness === 'bare_repo'
          ? 1
          : 2,
  }));

  const sorted = decorated
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ suggestion }) => suggestion);

  const environmentBacked = sorted.filter(
    (suggestion) => suggestion.workspaceReadiness === 'environment_backed',
  );
  const bareRepo = sorted.filter(
    (suggestion) => suggestion.workspaceReadiness === 'bare_repo',
  );
  const launchLimited = sorted.filter(
    (suggestion) => suggestion.workspaceReadiness === null,
  );

  if (environmentBacked.length === 0 || bareRepo.length === 0) {
    return sorted;
  }

  return [
    ...environmentBacked,
    ...bareRepo.slice(0, 2),
    ...launchLimited,
    ...bareRepo.slice(2),
  ];
}

function buildSuggestionSlackHeading(params: {
  title: string;
  priority: string | null;
}): string {
  if (params.priority && suggestionPrioritySet.has(params.priority)) {
    const priority = params.priority as SuggestionPriority;
    return `**${SUGGESTION_PRIORITY_EMOJIS[priority]} ${params.title}**`;
  }

  return `**${params.title}**`;
}

function buildSuggestionSlackFooter(params: {
  category: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentName: string | null;
  automationLabel?: string | null;
}): string | null {
  const automationLabel = params.automationLabel?.trim() || null;

  if (automationLabel) {
    const environmentName = params.targetEnvironmentName?.trim() || null;
    return environmentName
      ? `${automationLabel} in ${environmentName}`
      : automationLabel;
  }

  const location =
    params.targetEnvironmentName?.trim() ||
    params.targetRepositoryFullName?.trim() ||
    null;

  const kind =
    params.category && suggestionCategorySet.has(params.category)
      ? getSuggestionFooterKind(params.category as SuggestionCategory)
      : null;

  if (!kind && !location) {
    return null;
  }

  if (!location) {
    return kind;
  }

  return kind ? `${kind} in ${location}` : `Suggestion in ${location}`;
}

function getSuggestionFooterKind(category: SuggestionCategory): string {
  switch (category) {
    case 'bug':
      return 'Bug';
    case 'security':
      return 'Security issue';
    case 'chore':
      return 'Chore';
    case 'feature':
      return 'Feature';
    case 'improvement':
      return 'Improvement';
  }
}

async function postTaskSuggestionsThreadToSlack(params: {
  sourceTaskId: string;
  slackBotAccessToken: string;
  slackChannelId: string;
  createdByUserId: string | null;
  suggestionType: TaskSuggestionType;
  launchRouting?: 'router';
  rootText: string;
  existingRootMessageTs?: string;
  automationLabel?: string | null;
  automationSettingsHash?: string;
  historicalThreadFeedbackDebugSnippet?: string | null;
  suggestions: PersistedTaskSuggestion[];
  insertSuggestionMessages: (rows: SuggestionCardMessageRow[]) => Promise<void>;
}): Promise<{ rootMessageTs: string; trackedMessages: number } | null> {
  const slack = new SlackNotifier(params.slackBotAccessToken);
  const targetEnvironmentIds = [
    ...new Set(
      params.suggestions
        .map((suggestion) => suggestion.targetEnvironmentId)
        .filter(
          (targetEnvironmentId): targetEnvironmentId is string =>
            typeof targetEnvironmentId === 'string' &&
            targetEnvironmentId.length > 0,
        ),
    ),
  ];
  const environmentNamesById =
    targetEnvironmentIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await db
              .select({
                id: environments.id,
                name: environments.name,
              })
              .from(environments)
              .where(inArray(environments.id, targetEnvironmentIds))
          ).map((environment) => [environment.id, environment.name]),
        );
  let rootMessageTs = params.existingRootMessageTs?.trim() || null;

  if (!rootMessageTs) {
    const rootMessage = params.automationSettingsHash
      ? buildAutomationRootSummaryMessage({
          summaryText: params.rootText,
          automationSettingsHash: params.automationSettingsHash,
        })
      : { text: params.rootText };
    rootMessageTs =
      (await slack.postMessage({
        channel: params.slackChannelId,
        ...rootMessage,
      })) ?? null;
  }

  if (!rootMessageTs) {
    return null;
  }

  const historicalThreadFeedbackDebugSnippet =
    params.historicalThreadFeedbackDebugSnippet?.trim();

  const canPostHistoricalThreadFeedbackDebugSnippet =
    historicalThreadFeedbackDebugSnippet && params.createdByUserId
      ? await shouldPostHistoricalThreadFeedbackDebugSnippet({
          userId: params.createdByUserId,
          logPrefix: '[submitTaskSuggestions]',
          warn: (message) => apiLogger.warn(message),
        })
      : false;

  if (
    historicalThreadFeedbackDebugSnippet &&
    canPostHistoricalThreadFeedbackDebugSnippet
  ) {
    await slack.postMessage({
      channel: params.slackChannelId,
      thread_ts: rootMessageTs,
      text: historicalThreadFeedbackDebugSnippet,
      blocks: [
        {
          type: 'markdown',
          text: historicalThreadFeedbackDebugSnippet,
        },
      ],
    });
  }

  const suggestionMessageRows: SuggestionCardMessageRow[] = [];
  const useSharedSuggestionFormatting = usesSharedScheduledSuggestionSlackModel(
    params.suggestionType,
  );

  for (const suggestion of params.suggestions) {
    const heading = buildSuggestionSlackHeading({
      title: suggestion.title,
      priority: suggestion.priority,
    });
    const targetEnvironmentName = suggestion.targetEnvironmentId
      ? (environmentNamesById.get(suggestion.targetEnvironmentId) ?? null)
      : null;
    const footer = useSharedSuggestionFormatting
      ? null
      : buildSuggestionSlackFooter({
          category: suggestion.category,
          targetRepositoryFullName: suggestion.targetRepositoryFullName,
          targetEnvironmentName,
          automationLabel: params.automationLabel,
        });
    const footerContextBlock = footer
      ? [
          {
            type: 'context' as const,
            elements: [{ type: 'mrkdwn' as const, text: footer }],
          },
        ]
      : [];

    let text: string;
    let blocks: unknown[];

    if (useSharedSuggestionFormatting) {
      const sharedOptions = getSharedScheduledSuggestionSlackTextOptions(
        params.suggestionType,
      );
      // The fallback `text` keeps the footer inline; the rich `blocks` split it
      // into a small muted Slack `context` block so the bottom line renders as
      // secondary metadata instead of normal-size body text.
      text = buildSuggestionSlackText(
        {
          title: suggestion.title,
          brief: suggestion.brief,
          footerText: footer,
        },
        sharedOptions,
      );
      const body = buildSuggestionSlackText(
        {
          title: suggestion.title,
          brief: suggestion.brief,
          footerText: null,
        },
        sharedOptions,
      );
      blocks = [{ type: 'markdown', text: body }, ...footerContextBlock];
    } else {
      text = [heading, suggestion.brief, footer].filter(Boolean).join('\n');
      blocks = [
        { type: 'markdown', text: heading },
        { type: 'markdown', text: suggestion.brief },
        ...footerContextBlock,
      ];
    }

    const messageTs = await slack.postMessage({
      channel: params.slackChannelId,
      thread_ts: rootMessageTs,
      text,
      blocks,
      metadata: buildSuggestionMessageMetadata({
        sourceTaskId: params.sourceTaskId,
        suggestionId: suggestion.id,
      }),
    });

    if (!messageTs) {
      continue;
    }

    suggestionMessageRows.push({
      suggestionType: params.suggestionType,
      ...(params.launchRouting ? { launchRouting: params.launchRouting } : {}),
      messageTs,
      channelId: params.slackChannelId,
      workItemId: suggestion.id,
      suggestionKey: buildSuggestionMessageKey({
        sourceTaskId: params.sourceTaskId,
        suggestionId: suggestion.id,
      }),
      createdByUserId: params.createdByUserId,
    });
  }

  if (suggestionMessageRows.length === 0) {
    return {
      rootMessageTs,
      trackedMessages: 0,
    };
  }

  await params.insertSuggestionMessages(suggestionMessageRows);

  return {
    rootMessageTs,
    trackedMessages: suggestionMessageRows.length,
  };
}

async function postCurrentThreadSuggestionsToSlack(params: {
  sourceTaskId: string;
  slackChannelId: string;
  slackThreadTs: string;
  createdByUserId: string | null;
  launchRouting?: 'router';
  suggestions: PersistedTaskSuggestion[];
}): Promise<boolean> {
  const missingSuggestions = await getMissingTrackedSuggestions(
    params.suggestions,
    'slack',
  );

  if (missingSuggestions.length === 0) {
    return true;
  }

  const deliveredCount = params.suggestions.length - missingSuggestions.length;
  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation?.botAccessToken) {
    return false;
  }

  const postResult = await postTaskSuggestionsThreadToSlack({
    sourceTaskId: params.sourceTaskId,
    slackBotAccessToken: slackInstallation.botAccessToken,
    slackChannelId: params.slackChannelId,
    createdByUserId: params.createdByUserId,
    suggestionType: 'suggested_tasks',
    launchRouting: params.launchRouting,
    rootText: '',
    existingRootMessageTs: params.slackThreadTs,
    suggestions: missingSuggestions,
    insertSuggestionMessages: async (suggestionMessageRows) => {
      await db
        .insert(trackedMessages)
        .values(buildSlackSuggestionCardValues(suggestionMessageRows))
        .onConflictDoNothing({
          target: [trackedMessages.kind, trackedMessages.dedupeKey],
        });
    },
  });

  return Boolean(
    postResult &&
    deliveredCount + postResult.trackedMessages === params.suggestions.length,
  );
}

async function getMissingTrackedSuggestions(
  suggestions: PersistedTaskSuggestion[],
  surface: 'slack' | 'discord' | 'telegram' | 'teams',
): Promise<PersistedTaskSuggestion[]> {
  if (suggestions.length === 0) {
    return [];
  }

  const existingSuggestionCards = await db
    .select({ workItemId: trackedMessages.workItemId })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, surface),
        eq(trackedMessages.kind, 'suggestion_card'),
        inArray(
          trackedMessages.workItemId,
          suggestions.map((suggestion) => suggestion.id),
        ),
      ),
    );
  const deliveredWorkItemIds = new Set(
    existingSuggestionCards
      .map((card) => card.workItemId)
      .filter((workItemId): workItemId is string => Boolean(workItemId)),
  );
  const missingSuggestions = suggestions.filter(
    (suggestion) => !deliveredWorkItemIds.has(suggestion.id),
  );
  return missingSuggestions;
}

async function postSetupTaskSuggestionsToSlack(params: {
  sourceTaskId: string;
  slackChannel: string | null;
  createdByUserId: string | null;
  suggestions: PersistedTaskSuggestion[];
}): Promise<boolean> {
  const { sourceTaskId, slackChannel, createdByUserId, suggestions } = params;

  if (!slackChannel || !createdByUserId || suggestions.length === 0) {
    return false;
  }

  const missingSuggestions = await getMissingTrackedSuggestions(
    suggestions,
    'slack',
  );
  if (missingSuggestions.length === 0) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Slack suggestion post because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return true;
  }

  const [slackInstallation] = await db
    .select({
      botAccessToken: slackInstallations.botAccessToken,
      teamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (!slackInstallation) {
    return false;
  }

  const [creatorSlackMapping] = await db
    .select({ slackUserId: slackUserMappings.slackUserId })
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.userId, createdByUserId),
        eq(slackUserMappings.slackTeamId, slackInstallation.teamId),
      ),
    )
    .limit(1);

  const introText = creatorSlackMapping?.slackUserId
    ? `<@${creatorSlackMapping.slackUserId}> ${SETUP_SUGGESTIONS_THREAD_INTRO_TEXT}`
    : SETUP_SUGGESTIONS_THREAD_INTRO_TEXT;
  const postResult = await postTaskSuggestionsThreadToSlack({
    sourceTaskId,
    slackBotAccessToken: slackInstallation.botAccessToken,
    slackChannelId: slackChannel,
    createdByUserId,
    suggestionType: SETUP_ONBOARDING_SUGGESTION_TYPE,
    rootText: introText,
    suggestions: missingSuggestions,
    insertSuggestionMessages: async (suggestionMessageRows) => {
      await db
        .insert(trackedMessages)
        .values(buildSlackSuggestionCardValues(suggestionMessageRows))
        .onConflictDoNothing({
          target: [trackedMessages.kind, trackedMessages.dedupeKey],
        });
    },
  });

  if (!postResult || postResult.trackedMessages !== missingSuggestions.length) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] No setup suggestion messages were posted for sourceTaskId=${sourceTaskId} channel=${slackChannel}`,
    );
    return false;
  }

  apiLogger.debug(
    `[SetupSuggestionLifecycle] Published setup suggestions for sourceTaskId=${sourceTaskId} channel=${slackChannel} rootTs=${postResult.rootMessageTs} trackedMessages=${postResult.trackedMessages}`,
  );

  if (!creatorSlackMapping?.slackUserId) {
    return true;
  }

  const creatorSlackUserId = creatorSlackMapping.slackUserId;

  await scheduleSuggestedTasksFollowupBestEffort({
    surfaceLabel: 'Slack',
    sourceTaskId,
    enqueue: () =>
      enqueueSlackSuggestedTasksOnboardingFollowup({
        slackTeamId: slackInstallation.teamId,
        slackUserId: creatorSlackUserId,
        channelId: slackChannel,
        threadTs: postResult.rootMessageTs,
        sourceTaskId,
      }),
  });
  return true;
}

/**
 * Posts the scheduled-automation suggestion summary to Slack. Returns whether
 * Slack actually DELIVERED the summary (root message posted/persisted, or a
 * prior run already delivered it). The caller keys its other-provider fallback
 * on delivery, not on mere Slack-installation existence, so a Slack-installed
 * deployment that cannot resolve a channel still falls through to another provider.
 */
async function postSuggestedTasksSummaryToSlack(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestionSource?: TaskSuggestionSource;
  historicalThreadFeedbackDebugSnippet?: string | null;
  suggestions: PersistedTaskSuggestion[];
}): Promise<boolean> {
  if (params.suggestions.length === 0 || !params.sourceTaskId.trim()) {
    return false;
  }

  // Automation-initiated scans run as the deployment service principal and have
  // no user anywhere, so `createdByUserId` is null. A null poster must not
  // suppress the summary post; user-attribution decoration is skipped instead.
  const createdByUserId = params.createdByUserId;

  const [slackInstallation] = await db
    .select({
      id: slackInstallations.id,
      botAccessToken: slackInstallations.botAccessToken,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (!slackInstallation) {
    return false;
  }

  const slackConfig = resolveScheduledSuggestionSlackConfig(
    params.suggestionSource,
  );
  const automationLabel =
    getScheduledSuggestionBackgroundAutomationDescriptor(
      params.suggestionSource,
    )?.label ?? null;
  const shouldTrackAutomationThread = Boolean(params.suggestionSource);

  // Two-level fallback: the automation's own slack_channel target, then the
  // shared manager channel (getAutomationRuntime resolves both levels).
  const automationRuntime = await getAutomationRuntime(
    slackConfig.automationKey,
  );
  const configuredChannelId = automationRuntime.slackChannelId;

  const [channel] = configuredChannelId
    ? [{ channelId: configuredChannelId }]
    : await db
        .select({ channelId: slackInstallationChannels.channelId })
        .from(slackInstallationChannels)
        .where(
          eq(
            slackInstallationChannels.slackInstallationId,
            slackInstallation.id,
          ),
        )
        .orderBy(asc(slackInstallationChannels.createdAt))
        .limit(1);

  if (!channel) {
    return false;
  }

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${buildSuggestedTasksSummaryLockKey(
        {
          sourceTaskId: params.sourceTaskId,
        },
      )}))`,
    );

    const existingSuggestionCards = await tx
      .select({ workItemId: trackedMessages.workItemId })
      .from(trackedMessages)
      .where(
        and(
          eq(trackedMessages.surface, 'slack'),
          eq(trackedMessages.kind, 'suggestion_card'),
          inArray(
            trackedMessages.workItemId,
            params.suggestions.map((suggestion) => suggestion.id),
          ),
        ),
      );
    const existingWorkItemIds = new Set(
      existingSuggestionCards
        .map((card) => card.workItemId)
        .filter((workItemId): workItemId is string => Boolean(workItemId)),
    );
    const missingSuggestions = params.suggestions.filter(
      (suggestion) => !existingWorkItemIds.has(suggestion.id),
    );

    if (missingSuggestions.length === 0) {
      return true;
    }

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions: missingSuggestions,
    });

    const postResult = await postTaskSuggestionsThreadToSlack({
      sourceTaskId: params.sourceTaskId,
      slackBotAccessToken: slackInstallation.botAccessToken,
      slackChannelId: channel.channelId,
      createdByUserId,
      suggestionType: slackConfig.suggestionType,
      rootText: buildAutomationRootSummaryText({
        summaryText: rootMessage.summaryText,
        actionFooterText: rootMessage.actionFooterText,
      }),
      automationLabel,
      automationSettingsHash: slackConfig.automationSettingsHash,
      historicalThreadFeedbackDebugSnippet: supportsHistoricalThreadFeedback(
        slackConfig.automationKey,
      )
        ? params.historicalThreadFeedbackDebugSnippet
        : null,
      suggestions: missingSuggestions,
      insertSuggestionMessages: async (suggestionMessageRows) => {
        await tx
          .insert(trackedMessages)
          .values(buildSlackSuggestionCardValues(suggestionMessageRows))
          .onConflictDoNothing({
            target: [trackedMessages.kind, trackedMessages.dedupeKey],
          });
      },
    });

    if (
      postResult &&
      shouldTrackAutomationThread &&
      supportsHistoricalThreadFeedback(slackConfig.automationKey)
    ) {
      const slackThreadPayloadPatch = JSON.stringify({
        channel: channel.channelId,
        slackChannel: channel.channelId,
        thread_ts: postResult.rootMessageTs,
      });

      // Channel bindings live on the tasks row now.
      await tx
        .update(tasks)
        .set({
          slackChannelId: channel.channelId,
          slackThreadTs: postResult.rootMessageTs,
        })
        .where(eq(tasks.id, params.sourceTaskId));

      // Keep run payloads in sync for consumers that read Slack routing
      // metadata from the payload (prompt assembly, callbacks).
      await tx
        .update(taskRuns)
        .set({
          payload: sql`coalesce(${taskRuns.payload}, '{}'::jsonb) || ${slackThreadPayloadPatch}::jsonb`,
        })
        .where(eq(taskRuns.taskId, params.sourceTaskId));
    }

    if (postResult && shouldTrackAutomationThread) {
      await upsertBackgroundAutomationSlackThread(tx, {
        surface: 'slack',
        automationKey: slackConfig.automationKey,
        slackChannelId: channel.channelId,
        threadTs: postResult.rootMessageTs,
        summaryText: rootMessage.summaryText,
        postedAt: new Date(),
        metadata: {
          suggestionCount: params.suggestions.length,
          sourceTaskId: params.sourceTaskId,
        },
      });
    }

    // Delivered only when the root message was actually posted/persisted.
    return Boolean(
      postResult && postResult.trackedMessages === missingSuggestions.length,
    );
  });
}

/**
 * POST /api/mcp/tasks/:taskId/task_suggestions
 *
 * Persist suggested tasks submitted by a Suggested Tasks task.
 */
export async function submitTaskSuggestions(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsedBody = submitTaskSuggestionsBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json({ error: 'Invalid task suggestions payload' }, 400);
  }

  try {
    const [run, task, deploymentSettings] = await Promise.all([
      db.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, taskId),
        orderBy: (table, { desc }) => desc(table.id),
        columns: {
          id: true,
          payloadKind: true,
          actingUserId: true,
          payload: true,
        },
      }),
      db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: {
          initiatorUserId: true,
          initiatorAutomation: true,
          slackChannelId: true,
          slackThreadTs: true,
        },
      }),
      db.query.deploymentSettings.findFirst({
        columns: {
          setupNewState: true,
        },
      }),
    ]);

    if (!run) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const isCurrentThreadDelivery =
      parsedBody.data.delivery === 'current_thread';
    const isCurrentThreadTask =
      isCurrentThreadDelivery &&
      (run.payloadKind === TaskPayloadKind.StandardTask ||
        run.payloadKind === TaskPayloadKind.Scan ||
        run.payloadKind === TaskPayloadKind.SlackAppMention);
    const usesRouterLaunchContract =
      isCurrentThreadTask && run.payloadKind !== TaskPayloadKind.Scan;

    if (run.payloadKind !== TaskPayloadKind.Scan && !isCurrentThreadTask) {
      return c.json({ error: 'Task is not a Suggested Tasks task' }, 400);
    }

    if (isCurrentThreadTask && !parsedBody.data.submissionKey) {
      return c.json(
        { error: 'submissionKey is required for current-thread suggestions' },
        400,
      );
    }

    const payload = run.payload as SuggestedTasksPayload;
    const usesPinnedOrgWideLaunchContract =
      usesRouterLaunchContract && payload.repo === ALL_REPOSITORIES;
    const currentThreadLaunchRouting =
      usesRouterLaunchContract && !usesPinnedOrgWideLaunchContract
        ? ('router' as const)
        : undefined;
    const setupNewState = normalizeSetupNewState(
      deploymentSettings?.setupNewState,
    );
    const createdByUserId =
      auth.userId ?? run.actingUserId ?? task?.initiatorUserId ?? null;
    const isOnboardingTrigger =
      run.payloadKind === TaskPayloadKind.Scan &&
      !isCurrentThreadTask &&
      payload.trigger === 'onboarding';

    let candidateRepositories: ResolvedRepository[] = [];

    if (isOnboardingTrigger) {
      if (setupNewState.selectedRepositoryIds.length === 0) {
        return c.json(
          {
            error:
              'No repositories are currently selected for Suggested Tasks generation.',
          },
          400,
        );
      }

      if (payload.selectedRepositoryIds) {
        const payloadRepoIdSet = new Set(payload.selectedRepositoryIds);
        const currentRepoIds = setupNewState.selectedRepositoryIds;
        const reposMatch =
          currentRepoIds.length === payloadRepoIdSet.size &&
          currentRepoIds.every((repositoryId) =>
            payloadRepoIdSet.has(repositoryId),
          );

        if (!reposMatch) {
          return c.json(
            {
              error:
                'This Suggested Tasks run is no longer active for the current repository selection.',
            },
            409,
          );
        }
      }

      candidateRepositories = await resolveRepositoriesByIds({
        repositoryIds: setupNewState.selectedRepositoryIds,
      });
    } else {
      candidateRepositories = await resolveRepositoryIdsForSuggestedTask({
        payload,
      });

      if (candidateRepositories.length === 0) {
        return c.json(
          {
            error:
              'This Suggested Tasks run did not resolve to any repositories in this deployment.',
          },
          400,
        );
      }
    }

    const repositoryIds = candidateRepositories.map(
      (repository) => repository.id,
    );
    // Chat-reply suggestions are presentation-only proposals. Ignore launch
    // metadata from older workers so the task router chooses the workspace
    // when a user starts one instead of trusting the proposing agent.
    const submittedSuggestions = usesRouterLaunchContract
      ? parsedBody.data.suggestions.map((suggestion) => ({
          title: suggestion.title,
          brief: suggestion.brief,
          ...(usesPinnedOrgWideLaunchContract &&
          suggestion.targetRepositoryFullName
            ? {
                targetRepositoryFullName: suggestion.targetRepositoryFullName,
              }
            : {}),
        }))
      : parsedBody.data.suggestions;
    const suggestionsWithLaunchTargets = usesPinnedOrgWideLaunchContract
      ? await Promise.all(
          submittedSuggestions.map(async (suggestion) => {
            if (!suggestion.targetRepositoryFullName) {
              return suggestion;
            }

            const targetEnvironmentId = await findEnvironmentForRepo(
              suggestion.targetRepositoryFullName,
            );
            return targetEnvironmentId
              ? { ...suggestion, targetEnvironmentId }
              : suggestion;
          }),
        )
      : submittedSuggestions;
    const preparedSuggestions = await resolvePreparedSuggestions({
      suggestions: suggestionsWithLaunchTargets,
      candidateRepositories,
      tolerateInvalidSuggestions: !isOnboardingTrigger,
    });

    const suggestions = isOnboardingTrigger
      ? preparedSuggestions
      : prioritizeScheduledSuggestions(preparedSuggestions);
    const suggestionsMissingLaunchMetadata =
      isOnboardingTrigger ||
      (usesRouterLaunchContract && !usesPinnedOrgWideLaunchContract)
        ? []
        : suggestions.filter(
            (suggestion) => suggestion.targetRepositoryFullName === null,
          );

    if (suggestionsMissingLaunchMetadata.length > 0) {
      apiLogger.warn(
        `[submitTaskSuggestions] Persisting scheduled suggestions without per-idea launch metadata for taskId=${taskId}`,
      );
      apiLogger.warn(
        `[submitTaskSuggestions] Dropping ${suggestionsMissingLaunchMetadata.length} scheduled suggestions without per-idea launch metadata for taskId=${taskId}`,
      );
    }
    const suggestionsToPersist =
      isOnboardingTrigger ||
      (usesRouterLaunchContract && !usesPinnedOrgWideLaunchContract)
        ? suggestions
        : suggestions.filter(
            (suggestion) => suggestion.targetRepositoryFullName !== null,
          );

    const persistedSuggestions = await db.transaction(async (tx) => {
      const workItemColumns = {
        id: workItems.id,
        title: workItems.title,
        brief: workItems.brief,
        category: workItems.category,
        priority: workItems.priority,
        investigationContext: workItems.investigationContext,
        targetRepositoryFullName: workItems.targetRepositoryFullName,
        targetEnvironmentId: workItems.targetEnvironmentId,
        workspaceReadiness: workItems.workspaceReadiness,
        readinessMessage: workItems.readinessMessage,
        fingerprint: workItems.fingerprint,
        sortOrder: workItems.sortOrder,
      };

      const existingSuggestions = await tx
        .select(workItemColumns)
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, 'suggestion'),
            eq(workItems.sourceTaskId, taskId),
          ),
        )
        .orderBy(asc(workItems.sortOrder));

      const submissionPrefix = isCurrentThreadTask
        ? `${parsedBody.data.submissionKey}:`
        : null;
      const existingSubmissionSuggestions = submissionPrefix
        ? existingSuggestions.filter((suggestion) =>
            suggestion.fingerprint?.startsWith(submissionPrefix),
          )
        : existingSuggestions;

      if (existingSubmissionSuggestions.length > 0) {
        return existingSubmissionSuggestions.map(toPersistedTaskSuggestion);
      }

      if (!isCurrentThreadTask && existingSuggestions.length > 0) {
        return existingSuggestions.map(toPersistedTaskSuggestion);
      }

      if (suggestionsToPersist.length === 0) {
        return [] as PersistedTaskSuggestion[];
      }

      const insertedSuggestions = await tx
        .insert(workItems)
        .values(
          suggestionsToPersist.map((suggestion, index) => {
            const contentHash = buildTaskSuggestionContentHash({
              title: suggestion.title,
              brief: suggestion.brief,
              targetRepositoryFullName: suggestion.targetRepositoryFullName,
              repositoryIds,
            });

            return {
              kind: 'suggestion',
              // Automation-initiated scans stamp their originating automation;
              // onboarding/manual scans have no automation initiator (null FK).
              automationKey: task?.initiatorAutomation ?? null,
              sourceTaskId: taskId,
              title: suggestion.title,
              brief: suggestion.brief,
              category: suggestion.category,
              priority: suggestion.priority,
              investigationContext: suggestion.investigationContext,
              repositoryIds,
              targetRepositoryFullName: suggestion.targetRepositoryFullName,
              fingerprint: submissionPrefix
                ? `${submissionPrefix}${index}:${contentHash}`
                : contentHash,
              status: 'open',
              targetEnvironmentId: suggestion.targetEnvironmentId,
              workspaceReadiness: suggestion.workspaceReadiness,
              readinessMessage: suggestion.readinessMessage,
              sortOrder: existingSuggestions.length + index,
            } satisfies typeof workItems.$inferInsert;
          }),
        )
        .returning(workItemColumns);

      return insertedSuggestions.map(toPersistedTaskSuggestion);
    });

    if (isCurrentThreadTask) {
      const communicationProvider = (
        payload as { communicationProvider?: unknown }
      ).communicationProvider;
      const communicationChannel =
        getCommunicationChannelFromTaskPayload(payload);
      const communicationThread =
        getCommunicationThreadIdFromTaskPayload(payload);
      const providerSurface = task?.slackChannelId
        ? 'slack'
        : communicationProvider === 'discord' ||
            communicationProvider === 'telegram' ||
            communicationProvider === 'teams'
          ? communicationProvider
          : null;
      const missingSuggestions = providerSurface
        ? await getMissingTrackedSuggestions(
            persistedSuggestions,
            providerSurface,
          )
        : persistedSuggestions;
      const numberedMissingSuggestions = missingSuggestions.map(
        (suggestion) => ({
          ...suggestion,
          suggestionNumber:
            persistedSuggestions.findIndex(
              (candidate) => candidate.id === suggestion.id,
            ) + 1,
        }),
      );
      const delivered =
        missingSuggestions.length === 0
          ? true
          : task?.slackChannelId && task.slackThreadTs
            ? await postCurrentThreadSuggestionsToSlack({
                sourceTaskId: taskId,
                slackChannelId: task.slackChannelId,
                slackThreadTs: task.slackThreadTs,
                createdByUserId,
                launchRouting: currentThreadLaunchRouting,
                suggestions: missingSuggestions,
              })
            : communicationProvider === 'discord' && communicationChannel
              ? await postCurrentThreadSuggestionsToDiscord({
                  sourceTaskId: taskId,
                  suggestionGroupKey: parsedBody.data.submissionKey ?? taskId,
                  createdByUserId,
                  launchRouting: currentThreadLaunchRouting,
                  channelId: communicationChannel,
                  threadId: communicationThread,
                  suggestions: numberedMissingSuggestions,
                })
              : communicationProvider === 'telegram' && communicationChannel
                ? await postCurrentThreadSuggestionsToTelegram({
                    sourceTaskId: taskId,
                    suggestionGroupKey: parsedBody.data.submissionKey ?? taskId,
                    createdByUserId,
                    launchRouting: currentThreadLaunchRouting,
                    chatId: communicationChannel,
                    threadId: communicationThread,
                    suggestions: numberedMissingSuggestions,
                  })
                : communicationProvider === 'teams' && communicationChannel
                  ? await (async () => {
                      const serviceUrl =
                        getCommunicationServiceUrlFromTaskPayload(payload);
                      return serviceUrl
                        ? postCurrentThreadSuggestionsToTeams({
                            sourceTaskId: taskId,
                            suggestionGroupKey:
                              parsedBody.data.submissionKey ?? taskId,
                            createdByUserId,
                            launchRouting: currentThreadLaunchRouting,
                            conversationId: communicationChannel,
                            serviceUrl,
                            threadId: communicationThread,
                            suggestions: numberedMissingSuggestions,
                          })
                        : false;
                    })()
                  : false;

      if (!delivered) {
        return c.json(
          {
            success: false,
            error:
              'Failed to post task suggestions in the originating conversation.',
          },
          500,
        );
      }

      return c.json({
        success: true,
        suggestionCount: persistedSuggestions.length,
      });
    }

    if (isOnboardingTrigger) {
      const slackDelivered = await postSetupTaskSuggestionsToSlack({
        sourceTaskId: taskId,
        slackChannel: setupNewState.slackChannel,
        createdByUserId,
        suggestions: persistedSuggestions,
      });

      if (!slackDelivered) {
        const discordDelivered = await postSetupTaskSuggestionsToDiscord({
          sourceTaskId: taskId,
          createdByUserId,
          suggestions: persistedSuggestions,
        });

        if (!discordDelivered) {
          await postSetupTaskSuggestionsToTelegram({
            sourceTaskId: taskId,
            createdByUserId,
            suggestions: persistedSuggestions,
          });

          // Teams checks the shared tracked-message registry, so it only
          // delivers when Telegram did not claim this setup suggestion set.
          await postSetupTaskSuggestionsToTeams({
            sourceTaskId: taskId,
            createdByUserId,
            suggestions: persistedSuggestions,
          });
        }
      }
    }

    if (payload.notifySlack) {
      // Surface precedence (Slack > Discord > Telegram > Teams) is enforced HERE via the
      // delivered-boolean chain — each fallback fires only when the higher-
      // precedence surface did not actually deliver. The fallbacks no longer
      // self-suppress on Slack-installation existence, so a Slack-installed
      // deployment that cannot resolve a channel still reaches another provider.
      // An automation whose own destination target is a Discord channel skips
      // Slack entirely — its summary belongs in that channel.
      const suggestionRuntime = await getAutomationRuntime(
        resolveScheduledSuggestionSlackConfig(payload.suggestionSource)
          .automationKey,
      );
      // An automation with its own non-Slack destination skips higher-precedence
      // surfaces — the summary belongs on that surface.
      const preferredProvider = suggestionRuntime.destination?.provider;
      const preferredNonSlack =
        preferredProvider === 'discord' ||
        preferredProvider === 'telegram' ||
        preferredProvider === 'teams';
      const slackDelivered = preferredNonSlack
        ? false
        : await postSuggestedTasksSummaryToSlack({
            sourceTaskId: taskId,
            createdByUserId,
            suggestionSource: payload.suggestionSource,
            historicalThreadFeedbackDebugSnippet:
              payload.historicalThreadFeedbackDebugSnippet ?? null,
            suggestions: persistedSuggestions,
          });

      if (!slackDelivered) {
        const discordDelivered =
          preferredProvider === 'telegram' || preferredProvider === 'teams'
            ? false
            : await postScheduledSuggestionsToDiscord({
                sourceTaskId: taskId,
                createdByUserId,
                suggestionSource: payload.suggestionSource,
                suggestions: persistedSuggestions,
              });

        if (!discordDelivered) {
          const telegramDelivered =
            preferredProvider === 'teams'
              ? false
              : await postScheduledSuggestionsToTelegram({
                  sourceTaskId: taskId,
                  createdByUserId,
                  suggestionSource: payload.suggestionSource,
                  suggestions: persistedSuggestions,
                });

          if (!telegramDelivered) {
            await postScheduledSuggestionsToTeams({
              sourceTaskId: taskId,
              createdByUserId,
              suggestionSource: payload.suggestionSource,
              suggestions: persistedSuggestions,
            });
          }
        }
      }
    }

    return c.json({
      success: true,
      suggestionCount: persistedSuggestions.length,
    });
  } catch (error) {
    logHandlerError('submitTaskSuggestions', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to submit task suggestions',
      },
      500,
    );
  }
}
