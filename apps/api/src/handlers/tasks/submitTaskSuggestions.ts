import type { Context } from 'hono';
import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  type TaskPayload,
  TaskPayloadKind,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  isBetaBackgroundAutomationKey,
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
  hasTrackedSetupSuggestionMessages,
  scheduleSuggestedTasksFollowupBestEffort,
  SETUP_ONBOARDING_SUGGESTION_TYPE,
} from './setup-suggestion-lifecycle';
import { postScheduledSuggestionsToTelegram } from '../telegram/automation-suggestions';
import { postScheduledSuggestionsToTeams } from '../teams/automation-suggestions';
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
  suggestions: z.array(taskSuggestionSchema).max(5),
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
 * read so downstream Slack/Telegram/Teams formatting keeps a plain string.
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
  | 'security_auditor'
  | 'code_quality_auditor'
  | 'ci_failure_triage';

type SuggestionCardMessageRow = {
  suggestionType: TaskSuggestionType;
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
    return [...new Set(payload.selectedRepositories ?? [])].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  if (payload.repo?.trim()) {
    return [payload.repo.trim()];
  }

  return [];
}

async function resolveRepositoryIdsForSuggestedTask(params: {
  payload: SuggestedTasksPayload;
}): Promise<ResolvedRepository[]> {
  const repositoryFullNames = getSuggestedTaskRepositoryFullNames(
    params.payload,
  );

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
  ].slice(0, 5);
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
  rootText: string;
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
  const rootMessage = params.automationSettingsHash
    ? buildAutomationRootSummaryMessage({
        summaryText: params.rootText,
        automationSettingsHash: params.automationSettingsHash,
      })
    : { text: params.rootText };
  const rootMessageTs = await slack.postMessage({
    channel: params.slackChannelId,
    ...rootMessage,
  });

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
    const footer = buildSuggestionSlackFooter({
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
          category: suggestion.category,
          priority: suggestion.priority,
          targetRepositoryFullName: suggestion.targetRepositoryFullName,
          footerText: footer,
        },
        sharedOptions,
      );
      const body = buildSuggestionSlackText(
        {
          title: suggestion.title,
          brief: suggestion.brief,
          category: suggestion.category,
          priority: suggestion.priority,
          targetRepositoryFullName: suggestion.targetRepositoryFullName,
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

async function postSetupTaskSuggestionsToSlack(params: {
  sourceTaskId: string;
  slackChannel: string | null;
  createdByUserId: string | null;
  suggestions: PersistedTaskSuggestion[];
}): Promise<void> {
  const { sourceTaskId, slackChannel, createdByUserId, suggestions } = params;

  if (!slackChannel || !createdByUserId || suggestions.length === 0) {
    return;
  }

  if (await hasTrackedSetupSuggestionMessages(sourceTaskId)) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Slack suggestion post because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return;
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
    return;
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
    suggestions,
    insertSuggestionMessages: async (suggestionMessageRows) => {
      await db
        .insert(trackedMessages)
        .values(buildSlackSuggestionCardValues(suggestionMessageRows))
        .onConflictDoNothing({
          target: [trackedMessages.kind, trackedMessages.dedupeKey],
        });
    },
  });

  if (!postResult || postResult.trackedMessages === 0) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] No setup suggestion messages were posted for sourceTaskId=${sourceTaskId} channel=${slackChannel}`,
    );
    return;
  }

  apiLogger.debug(
    `[SetupSuggestionLifecycle] Published setup suggestions for sourceTaskId=${sourceTaskId} channel=${slackChannel} rootTs=${postResult.rootMessageTs} trackedMessages=${postResult.trackedMessages}`,
  );

  if (!creatorSlackMapping?.slackUserId) {
    return;
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
}

/**
 * Posts the scheduled-automation suggestion summary to Slack. Returns whether
 * Slack actually DELIVERED the summary (root message posted/persisted, or a
 * prior run already delivered it). The caller keys its Telegram/Teams fallback
 * on delivery, not on mere Slack-installation existence, so a Slack-installed
 * deployment that cannot resolve a channel still falls through to Telegram.
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

    const [existingSummaryMessage] = await tx
      .select({ id: trackedMessages.id })
      .from(trackedMessages)
      .where(
        and(
          eq(trackedMessages.kind, 'suggestion_card'),
          sql`${trackedMessages.metadata} ->> 'suggestionType' = ${slackConfig.suggestionType}`,
          sql`${trackedMessages.metadata} ->> 'suggestionKey' LIKE ${`${params.sourceTaskId}:%`}`,
        ),
      )
      .limit(1);

    if (existingSummaryMessage) {
      // A prior run already delivered this summary to Slack; treat as delivered
      // so the fallbacks stay suppressed.
      return true;
    }

    const rootMessage = await buildScheduledSuggestionRootMessage({
      slackConfig,
      actionFooterText: slackConfig.actionFooterText,
      suggestions: params.suggestions,
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
      historicalThreadFeedbackDebugSnippet: isBetaBackgroundAutomationKey(
        slackConfig.automationKey,
      )
        ? params.historicalThreadFeedbackDebugSnippet
        : null,
      suggestions: params.suggestions,
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
      isBetaBackgroundAutomationKey(slackConfig.automationKey)
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
    return Boolean(postResult);
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

    if (run.payloadKind !== TaskPayloadKind.Scan) {
      return c.json({ error: 'Task is not a Suggested Tasks task' }, 400);
    }

    const payload = run.payload as SuggestedTasksPayload;
    const setupNewState = normalizeSetupNewState(
      deploymentSettings?.setupNewState,
    );
    const createdByUserId =
      auth.userId ?? run.actingUserId ?? task?.initiatorUserId ?? null;
    const isOnboardingTrigger = payload.trigger === 'onboarding';

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
    const preparedSuggestions = await resolvePreparedSuggestions({
      suggestions: parsedBody.data.suggestions,
      candidateRepositories,
      tolerateInvalidSuggestions: !isOnboardingTrigger,
    });

    const suggestions = isOnboardingTrigger
      ? preparedSuggestions
      : prioritizeScheduledSuggestions(preparedSuggestions);
    const suggestionsMissingLaunchMetadata = isOnboardingTrigger
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
    const suggestionsToPersist = isOnboardingTrigger
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

      if (existingSuggestions.length > 0) {
        return existingSuggestions.map(toPersistedTaskSuggestion);
      }

      if (suggestionsToPersist.length === 0) {
        return [] as PersistedTaskSuggestion[];
      }

      const insertedSuggestions = await tx
        .insert(workItems)
        .values(
          suggestionsToPersist.map(
            (suggestion, index): typeof workItems.$inferInsert => ({
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
              // task_suggestions.contentHash lives on work_items.fingerprint.
              fingerprint: buildTaskSuggestionContentHash({
                title: suggestion.title,
                brief: suggestion.brief,
                targetRepositoryFullName: suggestion.targetRepositoryFullName,
                repositoryIds,
              }),
              status: 'open',
              targetEnvironmentId: suggestion.targetEnvironmentId,
              workspaceReadiness: suggestion.workspaceReadiness,
              readinessMessage: suggestion.readinessMessage,
              sortOrder: index,
            }),
          ),
        )
        .returning(workItemColumns);

      return insertedSuggestions.map(toPersistedTaskSuggestion);
    });

    if (isOnboardingTrigger) {
      await postSetupTaskSuggestionsToSlack({
        sourceTaskId: taskId,
        slackChannel: setupNewState.slackChannel,
        createdByUserId,
        suggestions: persistedSuggestions,
      });

      // Deployments without a Slack destination fall back to the captured
      // Telegram primary chat (one message with start buttons per idea).
      if (!setupNewState.slackChannel) {
        await postSetupTaskSuggestionsToTelegram({
          sourceTaskId: taskId,
          createdByUserId,
          suggestions: persistedSuggestions,
        });

        // Teams is the last onboarding fallback (Telegram outranks it;
        // checked inside).
        await postSetupTaskSuggestionsToTeams({
          sourceTaskId: taskId,
          createdByUserId,
          suggestions: persistedSuggestions,
        });
      }
    }

    if (payload.notifySlack) {
      // Surface precedence (Slack > Telegram > Teams) is enforced HERE via the
      // delivered-boolean chain — each fallback fires only when the higher-
      // precedence surface did not actually deliver. The fallbacks no longer
      // self-suppress on Slack-installation existence, so a Slack-installed
      // deployment that cannot resolve a channel still reaches Telegram/Teams.
      const slackDelivered = await postSuggestedTasksSummaryToSlack({
        sourceTaskId: taskId,
        createdByUserId,
        suggestionSource: payload.suggestionSource,
        historicalThreadFeedbackDebugSnippet:
          payload.historicalThreadFeedbackDebugSnippet ?? null,
        suggestions: persistedSuggestions,
      });

      if (!slackDelivered) {
        // Telegram fallback: the captured primary chat gets one message with
        // start buttons per suggestion.
        const telegramDelivered = await postScheduledSuggestionsToTelegram({
          sourceTaskId: taskId,
          createdByUserId,
          suggestionSource: payload.suggestionSource,
          suggestions: persistedSuggestions,
        });

        if (!telegramDelivered) {
          // Teams is the last fallback.
          await postScheduledSuggestionsToTeams({
            sourceTaskId: taskId,
            createdByUserId,
            suggestionSource: payload.suggestionSource,
            suggestions: persistedSuggestions,
          });
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
