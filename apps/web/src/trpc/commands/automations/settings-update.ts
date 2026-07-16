import {
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  DEFAULT_PR_REVIEW_SETTINGS,
  DEFAULT_SUGGESTER_ROUTING_MODE,
  getTriggerableBackgroundAutomationDescriptorByKey,
  isConflictResolverMaxPrAgeDays,
  type AutomationTarget,
  type SuggesterRoutingMode,
  type PrReviewSettings,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import {
  db,
  DEFAULT_CONFLICT_RESOLVER_LABEL,
  deploymentSettings,
  getAutomationRuntime,
  getBackgroundAgentSettingsForDeployment,
  MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS,
  upsertAutomation,
} from '@roomote/db/server';
import {
  findDiscordDestinationByChannelId,
  resolveAutomationRuntimeDestination,
} from '@roomote/sdk/server';
import { validateSuggestionRoutingInstructions } from '@roomote/cloud-agents/server';
import { FeatureFlag } from '@roomote/feature-flags';
import { resolveConfiguredGitHubAppSlug } from '@roomote/github';
import { SlackNotifier } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';

import {
  hasActiveGitHubInstallation,
  hasActiveRepository,
  hasActiveSentryIntegration,
  hasActiveSlackInstallation,
} from './automation-requirements';
import {
  mergeLegacySingleChannelAutoStartRows,
  normalizeChannelAutoStartInputRows,
  normalizeOptionalText,
  syncSlackAutoStartChannelCache,
} from './channel-auto-start';
import {
  assertAdmin,
  maskSlackChannelAutoStartSettings,
} from './feature-gates';
import {
  buildDefaultReviewerSettings,
  getRelayEligibleCreatorIds,
  listReviewerRelayUserRecords,
  mapReviewerSettingsToBackgroundSettings,
  type ReviewerRelayUser,
} from './reviewer';
import {
  getSlackChannelAccessWarnings,
  getSlackChannelDisplayNames,
  findActiveSlackInstallationForOrg,
  normalizeSlackChannelIdInput,
  resolveChannelId,
} from './slack-channels';
import type {
  BackgroundAgentFieldErrors,
  DiscordChannelFieldErrorKey,
  ResolvedChannelAutoStartRow,
  SlackChannelDisplayNames,
  UpdateBackgroundAgentSettingsInput,
} from './types';

type SuggestionRoutingPreviewRoute = Awaited<
  ReturnType<typeof validateSuggestionRoutingInstructions>
>['routes'][number];

function parseSentryProjectSlugs(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/[\s,]+/u)
        .map((slug) => slug.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

type SlackChannelResolution = Awaited<ReturnType<typeof resolveChannelId>>;

// When saving one automation, the form still submits the (display-name) Slack
// channel values for every other automation. Re-resolving those names against
// Slack would fail the whole save if any unrelated channel was archived, so for
// automations that aren't the one being saved we keep the already-persisted
// channel id instead of resolving the submitted name.
function keepPersistedSlackChannel(
  channelId: string | null | undefined,
): Promise<SlackChannelResolution> {
  return Promise.resolve({
    channelId: channelId ?? null,
    channelName: null,
    error: undefined,
  });
}

function buildSuggesterAutomationSettings(params: {
  routingInstructions: string | null;
  routingMode: SuggesterRoutingMode;
}): Record<string, string> {
  return {
    ...(params.routingInstructions
      ? { routingInstructions: params.routingInstructions }
      : {}),
    ...(params.routingMode !== DEFAULT_SUGGESTER_ROUTING_MODE
      ? { routingMode: params.routingMode }
      : {}),
  };
}

function buildSlackChannelTargets(
  channelId: string | null,
): AutomationTarget[] {
  return channelId
    ? [
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: channelId,
        },
      ]
    : [];
}

/**
 * Channel targets for automations whose destination picker offers a Slack OR
 * a Discord channel. Combined with
 * `managedTargetKinds: ['slack_channel', 'discord_channel']`, passing only
 * the selected provider's channel clears the other provider's target.
 */
function buildDestinationChannelTargets(
  slackChannelId: string | null | undefined,
  discordChannelId: string | null | undefined,
): AutomationTarget[] {
  return [
    ...(slackChannelId
      ? [
          {
            provider: 'slack' as const,
            targetKind: 'slack_channel' as const,
            externalRef: slackChannelId,
          },
        ]
      : []),
    ...(discordChannelId
      ? [
          {
            provider: 'discord' as const,
            targetKind: 'discord_channel' as const,
            externalRef: discordChannelId,
          },
        ]
      : []),
  ];
}

type DiscordChannelResolution = {
  channelId: string | null;
  error?: {
    field: DiscordChannelFieldErrorKey;
    message: string;
  };
};

// The Discord picker submits channel IDs straight from the cached channel
// catalog, so validation is a DB lookup instead of a live-API resolution.
async function resolveDiscordChannelId({
  field,
  input,
}: {
  field: DiscordChannelFieldErrorKey;
  input: string | null;
}): Promise<DiscordChannelResolution> {
  if (!input) {
    return { channelId: null };
  }

  const destination = await findDiscordDestinationByChannelId(input);

  if (!destination) {
    return {
      channelId: null,
      error: {
        field,
        message: 'This Discord channel is not available to Roomote.',
      },
    };
  }

  return { channelId: destination.channelId };
}

// Mirrors keepPersistedSlackChannel: automations that aren't being saved keep
// their already-persisted Discord channel instead of re-validating the
// submitted value.
function keepPersistedDiscordChannel(
  channelId: string | null | undefined,
): Promise<DiscordChannelResolution> {
  return Promise.resolve({ channelId: channelId ?? null });
}

export async function updateBackgroundAgentSettingsCommand(
  auth: UserAuthSuccess,
  input: UpdateBackgroundAgentSettingsInput,
): Promise<
  | {
      success: true;
      settings: Awaited<
        ReturnType<typeof getBackgroundAgentSettingsForDeployment>
      >;
      suggesterRoutingPreview: SuggestionRoutingPreviewRoute[] | null;
      reviewer: {
        id: string;
        enabled: boolean;
        environmentScope: NonNullable<PrReviewSettings['environmentScope']>;
        environmentIds: string[];
        authorReviewMode: NonNullable<PrReviewSettings['authorReviewMode']>;
        collaboratorLogins: string[];
        excludedAuthors: string | null;
        reviewAllPullRequestAuthors: boolean;
        reviewOnCommit: boolean;
        reviewDraftPrs: boolean;
        relayReviewResultsToTask: boolean;
        relayUsers: ReviewerRelayUser[];
        approvePr: boolean;
      };
      slackChannelAccessWarnings: {
        channelAutoStartSlackChannels: string[];
        managerSlackChannel: string | null;
        managerStatsSlackChannel: string | null;
        suggesterSlackChannel: string | null;
        announcerSlackChannel: string | null;
        platformIssueSlackChannel: string | null;
        sentryTriageSlackChannel: string | null;
        dependabotTriageSlackChannel: string | null;
        codeqlTriageSlackChannel: string | null;
        securityAuditorSlackChannel: string | null;
        codeQualityAuditorSlackChannel: string | null;
        ciFailureTriageSlackChannel: string | null;
      };
      slackChannelDisplayNames: SlackChannelDisplayNames;
    }
  | {
      success: false;
      fieldErrors: BackgroundAgentFieldErrors;
    }
> {
  assertAdmin(auth);
  const fieldErrors: BackgroundAgentFieldErrors = {};
  const existingSettings = await getBackgroundAgentSettingsForDeployment();
  const shouldUpdateChannelAutoStart =
    input.savingAutomation === 'channelAutoStart';
  const shouldUpdateManagerStats = input.savingAutomation === 'managerStats';
  const shouldUpdateSentryTriage = input.savingAutomation === 'sentryTriage';
  const shouldUpdateDependabotTriage =
    input.savingAutomation === 'dependabotTriage';
  const shouldUpdateCodeqlTriage = input.savingAutomation === 'codeqlTriage';
  const shouldUpdateSuggester = input.savingAutomation === 'suggester';
  const shouldUpdateAnnouncer = input.savingAutomation === 'announcer';
  const shouldUpdatePlatformIssueAlerts =
    input.savingAutomation === 'platformIssueAlerts';
  const shouldUpdateSecurityAuditor =
    input.savingAutomation === 'securityAuditor';
  const shouldUpdateCodeQualityAuditor =
    input.savingAutomation === 'codeQualityAuditor';
  const shouldUpdateCiFailureTriage =
    input.savingAutomation === 'ciFailureTriage';

  const conflictResolverLabel =
    input.conflictResolverLabel.trim() || DEFAULT_CONFLICT_RESOLVER_LABEL;
  const conflictResolverMaxPrAgeDays =
    input.conflictResolverMaxPrAgeDays ??
    existingSettings.conflictResolverMaxPrAgeDays ??
    DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS;

  if (!conflictResolverLabel) {
    fieldErrors.conflictResolverLabel = 'Conflict resolver label is required.';
  }

  if (!isConflictResolverMaxPrAgeDays(conflictResolverMaxPrAgeDays)) {
    fieldErrors.conflictResolverMaxPrAgeDays = 'Choose a valid PR age cap.';
  }

  if ((input.conflictResolverInstructions?.length ?? 0) > 8_000) {
    fieldErrors.conflictResolverInstructions =
      'Conflict resolver instructions are too long.';
  }

  const channelAutoStartRows = shouldUpdateChannelAutoStart
    ? normalizeChannelAutoStartInputRows({
        rows: input.channelAutoStartSlackChannels,
        legacyEnabled: input.channelAutoStartEnabled,
        legacyChannel: input.channelAutoStartSlackChannel,
        legacyInstructions: input.channelAutoStartInstructions,
      })
    : [];

  if (
    shouldUpdateChannelAutoStart &&
    channelAutoStartRows.some((row) => (row.instructions?.length ?? 0) > 8_000)
  ) {
    fieldErrors.channelAutoStartInstructions =
      'Each auto-respond channel can include up to 8,000 instruction characters.';
  }

  if (
    shouldUpdateChannelAutoStart &&
    channelAutoStartRows.some(
      (row) => (row.launchCriteria?.length ?? 0) > 4_000,
    )
  ) {
    fieldErrors.channelAutoStartLaunchCriteria =
      'Each auto-respond channel can include up to 4,000 launch criteria characters.';
  }

  if ((input.suggesterInstructions?.length ?? 0) > 10_000) {
    fieldErrors.suggesterInstructions = 'Suggestion preferences are too long.';
  }

  if ((input.suggesterRoutingInstructions?.length ?? 0) > 10_000) {
    fieldErrors.suggesterRoutingInstructions =
      'Grouping and routing instructions are too long.';
  }

  const suggestionRoutingEnabled =
    auth.featureFlags[FeatureFlag.SuggestionRouting] === true;
  const effectiveSuggesterRoutingMode = suggestionRoutingEnabled
    ? (input.suggesterRoutingMode ?? DEFAULT_SUGGESTER_ROUTING_MODE)
    : existingSettings.suggesterRoutingMode;
  const effectiveSuggesterRoutingInstructions = suggestionRoutingEnabled
    ? normalizeOptionalText(input.suggesterRoutingInstructions)
    : existingSettings.suggesterRoutingInstructions;
  const shouldValidateSuggesterRoutingPreview =
    suggestionRoutingEnabled &&
    input.savingAutomation === 'suggester' &&
    effectiveSuggesterRoutingMode === 'group_by_instructions';
  let suggesterRoutingPreview: SuggestionRoutingPreviewRoute[] | null = null;

  if (shouldValidateSuggesterRoutingPreview) {
    if (!effectiveSuggesterRoutingInstructions) {
      fieldErrors.suggesterRoutingInstructions =
        'Grouping and routing instructions are required.';
    }
  }

  const sentryTriageProjectSlugs = input.sentryTriageProjectSlugs ?? null;

  if ((sentryTriageProjectSlugs?.length ?? 0) > 4_000) {
    fieldErrors.sentryTriageProjectSlugs = 'Sentry project scope is too long.';
  }

  if ((input.announcerInstructions?.length ?? 0) > 8_000) {
    fieldErrors.announcerInstructions = 'Announcer instructions are too long.';
  }

  const shouldUpdateManagerChannel =
    input.savingAutomation === 'managerChannel';
  const submittedManagerSlackChannel = normalizeOptionalText(
    input.managerSlackChannel ?? null,
  );
  const managerSlackChannel = shouldUpdateManagerChannel
    ? submittedManagerSlackChannel
    : null;
  const managerStatsFrequency = input.managerStatsFrequency ?? 'off';
  // One-of destination semantics for the automation being saved: the picker
  // submits either a Slack or a Discord channel. The UI clears the other
  // provider on selection; as the server-side backstop, when both somehow
  // arrive we prefer the Discord value and drop Slack.
  const managerStatsDiscordChannel = shouldUpdateManagerStats
    ? normalizeOptionalText(input.managerStatsDiscordChannel)
    : null;
  const sentryTriageDiscordChannel = shouldUpdateSentryTriage
    ? normalizeOptionalText(input.sentryTriageDiscordChannel)
    : null;
  const dependabotTriageDiscordChannel = shouldUpdateDependabotTriage
    ? normalizeOptionalText(input.dependabotTriageDiscordChannel)
    : null;
  const codeqlTriageDiscordChannel = shouldUpdateCodeqlTriage
    ? normalizeOptionalText(input.codeqlTriageDiscordChannel)
    : null;
  const securityAuditorDiscordChannel = shouldUpdateSecurityAuditor
    ? normalizeOptionalText(input.securityAuditorDiscordChannel)
    : null;
  const codeQualityAuditorDiscordChannel = shouldUpdateCodeQualityAuditor
    ? normalizeOptionalText(input.codeQualityAuditorDiscordChannel)
    : null;
  const ciFailureTriageDiscordChannel = shouldUpdateCiFailureTriage
    ? normalizeOptionalText(input.ciFailureTriageDiscordChannel)
    : null;
  const managerStatsSlackChannel =
    shouldUpdateManagerStats && !managerStatsDiscordChannel
      ? normalizeOptionalText(input.managerStatsSlackChannel)
      : null;
  const sentryTriageSlackChannel =
    shouldUpdateSentryTriage && !sentryTriageDiscordChannel
      ? normalizeOptionalText(input.sentryTriageSlackChannel)
      : null;
  const dependabotTriageSlackChannel =
    shouldUpdateDependabotTriage && !dependabotTriageDiscordChannel
      ? normalizeOptionalText(input.dependabotTriageSlackChannel)
      : null;
  const codeqlTriageSlackChannel =
    shouldUpdateCodeqlTriage && !codeqlTriageDiscordChannel
      ? normalizeOptionalText(input.codeqlTriageSlackChannel)
      : null;
  const suggesterSlackChannel = shouldUpdateSuggester
    ? normalizeOptionalText(input.suggesterSlackChannel)
    : null;
  const announcerSlackChannel = shouldUpdateAnnouncer
    ? normalizeOptionalText(input.announcerSlackChannel)
    : null;
  const platformIssueSlackChannel = shouldUpdatePlatformIssueAlerts
    ? normalizeOptionalText(input.platformIssueSlackChannel)
    : null;
  const securityAuditorSlackChannel =
    shouldUpdateSecurityAuditor && !securityAuditorDiscordChannel
      ? normalizeOptionalText(input.securityAuditorSlackChannel)
      : null;
  const codeQualityAuditorSlackChannel =
    shouldUpdateCodeQualityAuditor && !codeQualityAuditorDiscordChannel
      ? normalizeOptionalText(input.codeQualityAuditorSlackChannel)
      : null;
  const ciFailureTriageSlackChannel =
    shouldUpdateCiFailureTriage && !ciFailureTriageDiscordChannel
      ? normalizeOptionalText(input.ciFailureTriageSlackChannel)
      : null;
  const suggesterRoutingRequiresSlackInstallation =
    shouldValidateSuggesterRoutingPreview &&
    Boolean(effectiveSuggesterRoutingInstructions);
  const channelAutoStartRequiresSlackInstallation =
    shouldUpdateChannelAutoStart &&
    channelAutoStartRows.some((row) => Boolean(row.slackChannel));

  const requiresSlackInstallation =
    channelAutoStartRequiresSlackInstallation ||
    Boolean(managerSlackChannel) ||
    Boolean(managerStatsSlackChannel) ||
    Boolean(sentryTriageSlackChannel) ||
    Boolean(dependabotTriageSlackChannel) ||
    Boolean(codeqlTriageSlackChannel) ||
    Boolean(suggesterSlackChannel) ||
    Boolean(announcerSlackChannel) ||
    Boolean(platformIssueSlackChannel) ||
    Boolean(securityAuditorSlackChannel) ||
    Boolean(codeQualityAuditorSlackChannel) ||
    Boolean(ciFailureTriageSlackChannel) ||
    suggesterRoutingRequiresSlackInstallation;

  const slackInstallation = requiresSlackInstallation
    ? await findActiveSlackInstallationForOrg()
    : null;

  const notifier = slackInstallation
    ? new SlackNotifier(slackInstallation.botAccessToken)
    : null;

  if (requiresSlackInstallation && !notifier) {
    fieldErrors.general = 'Connect Slack before configuring agent channels.';
  }

  const [
    channelAutoStartChannelResults,
    managerChannelResult,
    managerStatsChannelResult,
    sentryTriageChannelResult,
    dependabotTriageChannelResult,
    codeqlTriageChannelResult,
    suggesterChannelResult,
    announcerChannelResult,
    platformIssueChannelResult,
    securityAuditorChannelResult,
    codeQualityAuditorChannelResult,
    ciFailureTriageChannelResult,
  ] = await Promise.all([
    Promise.all(
      channelAutoStartRows.map((row) =>
        resolveChannelId({
          field: 'channelAutoStartSlackChannels',
          // Prefer the persisted channel ID for untouched rows: resolving by ID
          // short-circuits without a Slack lookup, so an archived/renamed/private
          // channel elsewhere in the list can't block saving an edit to another
          // row. Fall back to the submitted name for new or channel-edited rows.
          input:
            normalizeSlackChannelIdInput(row.channelId) ?? row.slackChannel,
          notifier,
        }),
      ),
    ),
    shouldUpdateManagerChannel
      ? resolveChannelId({
          field: 'managerSlackChannel',
          input: managerSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.managerSlackChannelId ??
            normalizeSlackChannelIdInput(submittedManagerSlackChannel),
        ),
    shouldUpdateManagerStats
      ? resolveChannelId({
          field: 'managerStatsSlackChannel',
          input: managerStatsSlackChannel,
          notifier,
        })
      : // The persisted per-automation Slack ids include the manager-channel
        // fallback. When the automation's own destination is a Discord
        // channel, keeping that fallback would write it back as an own Slack
        // target and override the Discord destination, so drop it.
        keepPersistedSlackChannel(
          existingSettings?.managerStatsDiscordChannelId
            ? null
            : existingSettings?.managerStatsSlackChannelId,
        ),
    shouldUpdateSentryTriage
      ? resolveChannelId({
          field: 'sentryTriageSlackChannel',
          input: sentryTriageSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.sentryTriageDiscordChannelId
            ? null
            : existingSettings?.sentryTriageSlackChannelId,
        ),
    shouldUpdateDependabotTriage
      ? resolveChannelId({
          field: 'dependabotTriageSlackChannel',
          input: dependabotTriageSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.dependabotTriageDiscordChannelId
            ? null
            : existingSettings?.dependabotTriageSlackChannelId,
        ),
    shouldUpdateCodeqlTriage
      ? resolveChannelId({
          field: 'codeqlTriageSlackChannel',
          input: codeqlTriageSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.codeqlTriageDiscordChannelId
            ? null
            : existingSettings?.codeqlTriageSlackChannelId,
        ),
    shouldUpdateSuggester
      ? resolveChannelId({
          field: 'suggesterSlackChannel',
          input: suggesterSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(existingSettings?.suggesterSlackChannelId),
    shouldUpdateAnnouncer
      ? resolveChannelId({
          field: 'announcerSlackChannel',
          input: announcerSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(existingSettings?.announcerSlackChannelId),
    shouldUpdatePlatformIssueAlerts
      ? resolveChannelId({
          field: 'platformIssueSlackChannel',
          input: platformIssueSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.platformIssueSlackChannelId,
        ),
    shouldUpdateSecurityAuditor
      ? resolveChannelId({
          field: 'securityAuditorSlackChannel',
          input: securityAuditorSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.securityAuditorDiscordChannelId
            ? null
            : existingSettings?.securityAuditorSlackChannelId,
        ),
    shouldUpdateCodeQualityAuditor
      ? resolveChannelId({
          field: 'codeQualityAuditorSlackChannel',
          input: codeQualityAuditorSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.codeQualityAuditorDiscordChannelId
            ? null
            : existingSettings?.codeQualityAuditorSlackChannelId,
        ),
    shouldUpdateCiFailureTriage
      ? resolveChannelId({
          field: 'ciFailureTriageSlackChannel',
          input: ciFailureTriageSlackChannel,
          notifier,
        })
      : keepPersistedSlackChannel(
          existingSettings?.ciFailureTriageDiscordChannelId
            ? null
            : existingSettings?.ciFailureTriageSlackChannelId,
        ),
  ]);

  const [
    managerStatsDiscordResult,
    sentryTriageDiscordResult,
    dependabotTriageDiscordResult,
    codeqlTriageDiscordResult,
    securityAuditorDiscordResult,
    codeQualityAuditorDiscordResult,
    ciFailureTriageDiscordResult,
  ] = await Promise.all([
    shouldUpdateManagerStats
      ? resolveDiscordChannelId({
          field: 'managerStatsDiscordChannel',
          input: managerStatsDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.managerStatsDiscordChannelId,
        ),
    shouldUpdateSentryTriage
      ? resolveDiscordChannelId({
          field: 'sentryTriageDiscordChannel',
          input: sentryTriageDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.sentryTriageDiscordChannelId,
        ),
    shouldUpdateDependabotTriage
      ? resolveDiscordChannelId({
          field: 'dependabotTriageDiscordChannel',
          input: dependabotTriageDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.dependabotTriageDiscordChannelId,
        ),
    shouldUpdateCodeqlTriage
      ? resolveDiscordChannelId({
          field: 'codeqlTriageDiscordChannel',
          input: codeqlTriageDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.codeqlTriageDiscordChannelId,
        ),
    shouldUpdateSecurityAuditor
      ? resolveDiscordChannelId({
          field: 'securityAuditorDiscordChannel',
          input: securityAuditorDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.securityAuditorDiscordChannelId,
        ),
    shouldUpdateCodeQualityAuditor
      ? resolveDiscordChannelId({
          field: 'codeQualityAuditorDiscordChannel',
          input: codeQualityAuditorDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.codeQualityAuditorDiscordChannelId,
        ),
    shouldUpdateCiFailureTriage
      ? resolveDiscordChannelId({
          field: 'ciFailureTriageDiscordChannel',
          input: ciFailureTriageDiscordChannel,
        })
      : keepPersistedDiscordChannel(
          existingSettings?.ciFailureTriageDiscordChannelId,
        ),
  ]);

  for (const result of [
    managerStatsDiscordResult,
    sentryTriageDiscordResult,
    dependabotTriageDiscordResult,
    codeqlTriageDiscordResult,
    securityAuditorDiscordResult,
    codeQualityAuditorDiscordResult,
    ciFailureTriageDiscordResult,
  ]) {
    if (result.error) {
      fieldErrors[result.error.field] = result.error.message;
    }
  }

  for (const result of channelAutoStartChannelResults) {
    if (result.error) {
      fieldErrors[result.error.field] = result.error.message;
      break;
    }
  }

  for (const result of [
    managerChannelResult,
    managerStatsChannelResult,
    sentryTriageChannelResult,
    dependabotTriageChannelResult,
    codeqlTriageChannelResult,
    suggesterChannelResult,
    announcerChannelResult,
    platformIssueChannelResult,
    securityAuditorChannelResult,
    codeQualityAuditorChannelResult,
    ciFailureTriageChannelResult,
  ]) {
    if (result.error) {
      fieldErrors[result.error.field] = result.error.message;
    }
  }

  if (
    shouldValidateSuggesterRoutingPreview &&
    effectiveSuggesterRoutingInstructions &&
    notifier &&
    !fieldErrors.suggesterRoutingInstructions
  ) {
    try {
      const validation = await validateSuggestionRoutingInstructions({
        routingInstructions: effectiveSuggesterRoutingInstructions,
        availableChannels: await notifier.listAccessibleChannels(),
        userId: auth.userId,
      });

      if (!validation.isValid) {
        fieldErrors.suggesterRoutingInstructions =
          validation.issues[0] ??
          'Roomote could not confidently map those groups to Slack channels.';
      } else {
        suggesterRoutingPreview = validation.routes;
      }
    } catch {
      fieldErrors.suggesterRoutingInstructions =
        'Roomote could not validate those routing instructions right now.';
    }
  }

  const resolvedChannelAutoStartRows: ResolvedChannelAutoStartRow[] =
    channelAutoStartRows.flatMap((row, index) => {
      const resolution = channelAutoStartChannelResults[index];

      if (!resolution?.channelId) {
        return [];
      }

      return [
        {
          channelId: resolution.channelId,
          channelName: resolution.channelName ?? row.slackChannel,
          instructions: row.instructions,
          launchMode: row.launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
          launchCriteria: normalizeOptionalText(row.launchCriteria),
        },
      ];
    });

  if (
    shouldUpdateChannelAutoStart &&
    channelAutoStartRows.some((row) => !row.slackChannel && !row.channelId) &&
    !fieldErrors.channelAutoStartSlackChannels
  ) {
    fieldErrors.channelAutoStartSlackChannels =
      'Each auto-respond channel needs a Slack channel.';
  }

  if (
    shouldUpdateChannelAutoStart &&
    !fieldErrors.channelAutoStartSlackChannels
  ) {
    const seenChannelIds = new Set<string>();
    for (const row of resolvedChannelAutoStartRows) {
      if (seenChannelIds.has(row.channelId)) {
        fieldErrors.channelAutoStartSlackChannels =
          'Each auto-respond channel can only be configured once.';
        break;
      }
      seenChannelIds.add(row.channelId);
    }
  }

  const usingLegacyChannelAutoStartInput =
    input.channelAutoStartSlackChannels === undefined &&
    (input.channelAutoStartEnabled !== undefined ||
      input.channelAutoStartSlackChannel !== undefined ||
      input.channelAutoStartInstructions !== undefined);
  const finalResolvedChannelAutoStartRows = shouldUpdateChannelAutoStart
    ? mergeLegacySingleChannelAutoStartRows({
        submittedRows: resolvedChannelAutoStartRows,
        existingRows: existingSettings?.channelAutoStartSlackChannels,
        usingLegacyInput: usingLegacyChannelAutoStartInput,
      })
    : (existingSettings?.channelAutoStartSlackChannels ?? []).map((row) => ({
        channelId: row.channelId,
        channelName: null,
        instructions: row.instructions ?? null,
        launchMode: row.launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: row.launchCriteria ?? null,
      }));
  const managerChannelChanged =
    Boolean(managerChannelResult.channelId) &&
    managerChannelResult.channelId !== existingSettings?.managerSlackChannelId;
  const channelAutoStartChannelIds = finalResolvedChannelAutoStartRows.map(
    ({ channelId }) => channelId,
  );
  const managerChannelHasApp =
    input.savingAutomation === 'managerChannel' &&
    managerChannelChanged &&
    managerChannelResult.channelId &&
    notifier
      ? (await notifier.isAppInChannel(managerChannelResult.channelId)) === true
      : false;
  const effectiveSuggesterFrequency = managerChannelHasApp
    ? MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.suggesterFrequency
    : input.suggesterFrequency;
  const effectiveAnnouncerFrequency = managerChannelHasApp
    ? MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.announcerFrequency
    : input.announcerFrequency;
  const effectiveManagerStatsFrequency = managerChannelHasApp
    ? MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.managerStatsFrequency
    : managerStatsFrequency;
  const normalizedSuggesterInstructions = normalizeOptionalText(
    input.suggesterInstructions,
  );
  const effectiveSuggesterInstructions =
    effectiveSuggesterRoutingMode === 'group_by_instructions'
      ? existingSettings.suggesterInstructions
      : normalizedSuggesterInstructions;
  const suggesterAutomationSettings = buildSuggesterAutomationSettings({
    routingMode: effectiveSuggesterRoutingMode,
    routingInstructions: effectiveSuggesterRoutingInstructions,
  });
  const sentryTriageFrequency = input.sentryTriageFrequency ?? 'off';
  const dependabotTriageFrequency = input.dependabotTriageFrequency ?? 'off';
  const codeqlTriageFrequency = input.codeqlTriageFrequency ?? 'off';
  const securityAuditorFrequency = input.securityAuditorFrequency ?? 'off';
  const codeQualityAuditorFrequency =
    input.codeQualityAuditorFrequency ?? 'off';
  const ciFailureTriageFrequency = input.ciFailureTriageFrequency ?? 'off';

  // Manager-channel automations resolve their Slack destination as
  // automation target -> shared manager channel. Enabling one requires a
  // channel at one of those two levels.
  const sharedManagerChannelId = managerChannelResult.channelId;
  const managerChannelAutomationValidations: Array<{
    key: TriggerableBackgroundAutomationKey;
    frequency: string;
    channelId: string | null;
    field:
      | 'managerStatsSlackChannel'
      | 'sentryTriageSlackChannel'
      | 'dependabotTriageSlackChannel'
      | 'codeqlTriageSlackChannel'
      | 'securityAuditorSlackChannel'
      | 'codeQualityAuditorSlackChannel'
      | 'ciFailureTriageSlackChannel'
      | 'suggesterSlackChannel'
      | 'announcerSlackChannel';
  }> = [
    {
      key: 'suggester',
      frequency: effectiveSuggesterFrequency,
      channelId: suggesterChannelResult.channelId,
      field: 'suggesterSlackChannel',
    },
    {
      key: 'announcer',
      frequency: effectiveAnnouncerFrequency,
      channelId: announcerChannelResult.channelId,
      field: 'announcerSlackChannel',
    },
    // A per-automation Discord destination satisfies the channel requirement
    // just like a per-automation Slack channel does.
    {
      key: 'manager_stats',
      frequency: effectiveManagerStatsFrequency,
      channelId:
        managerStatsChannelResult.channelId ??
        managerStatsDiscordResult.channelId,
      field: 'managerStatsSlackChannel',
    },
    {
      key: 'sentry_triage',
      frequency: sentryTriageFrequency,
      channelId:
        sentryTriageChannelResult.channelId ??
        sentryTriageDiscordResult.channelId,
      field: 'sentryTriageSlackChannel',
    },
    {
      key: 'dependabot_triage',
      frequency: dependabotTriageFrequency,
      channelId:
        dependabotTriageChannelResult.channelId ??
        dependabotTriageDiscordResult.channelId,
      field: 'dependabotTriageSlackChannel',
    },
    {
      key: 'codeql_triage',
      frequency: codeqlTriageFrequency,
      channelId:
        codeqlTriageChannelResult.channelId ??
        codeqlTriageDiscordResult.channelId,
      field: 'codeqlTriageSlackChannel',
    },
    {
      key: 'security_auditor',
      frequency: securityAuditorFrequency,
      channelId:
        securityAuditorChannelResult.channelId ??
        securityAuditorDiscordResult.channelId,
      field: 'securityAuditorSlackChannel',
    },
    {
      key: 'code_quality_auditor',
      frequency: codeQualityAuditorFrequency,
      channelId:
        codeQualityAuditorChannelResult.channelId ??
        codeQualityAuditorDiscordResult.channelId,
      field: 'codeQualityAuditorSlackChannel',
    },
    {
      key: 'ci_failure_triage',
      frequency: ciFailureTriageFrequency,
      channelId:
        ciFailureTriageChannelResult.channelId ??
        ciFailureTriageDiscordResult.channelId,
      field: 'ciFailureTriageSlackChannel',
    },
  ];

  for (const validation of managerChannelAutomationValidations) {
    if (validation.frequency === 'off') {
      continue;
    }

    if (!validation.channelId && !sharedManagerChannelId) {
      // Without any Slack-level channel, the automation can still run when
      // its runner supports another connected comms surface and a
      // destination resolves there (an existing teams/telegram target, or
      // the primary-conversation fallback on Slack-less deployments).
      const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
        validation.key,
      );
      const nonSlackProviders =
        descriptor?.supportedCommunicationProviders.filter(
          (provider) => provider !== 'slack',
        ) ?? [];

      if (nonSlackProviders.length > 0) {
        const runtime = await getAutomationRuntime(validation.key);
        const destination = await resolveAutomationRuntimeDestination({
          runtime,
          slackConnected: await hasActiveSlackInstallation(),
        });

        if (destination && nonSlackProviders.includes(destination.provider)) {
          continue;
        }
      }

      const label = descriptor?.label ?? validation.key;
      fieldErrors[validation.field] =
        fieldErrors[validation.field] ||
        `Choose a Slack channel before enabling ${label}.`;
    }
  }

  if (
    sentryTriageFrequency !== 'off' &&
    !(await hasActiveSentryIntegration())
  ) {
    fieldErrors.general =
      fieldErrors.general ||
      'Configure Sentry in Settings > Integrations before enabling Triage Sentry Issues.';
  }

  if (
    dependabotTriageFrequency !== 'off' &&
    !(await hasActiveGitHubInstallation())
  ) {
    fieldErrors.general =
      fieldErrors.general ||
      'Connect GitHub before enabling Triage Dependabot Alerts.';
  }

  if (dependabotTriageFrequency !== 'off' && !(await hasActiveRepository())) {
    fieldErrors.general =
      fieldErrors.general ||
      'Add at least one active repository before enabling Triage Dependabot Alerts.';
  }

  if (
    codeqlTriageFrequency !== 'off' &&
    !(await hasActiveGitHubInstallation())
  ) {
    fieldErrors.general =
      fieldErrors.general ||
      'Connect GitHub before enabling Triage CodeQL Alerts.';
  }

  if (codeqlTriageFrequency !== 'off' && !(await hasActiveRepository())) {
    fieldErrors.general =
      fieldErrors.general ||
      'Add at least one active repository before enabling Triage CodeQL Alerts.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      fieldErrors,
    };
  }

  const now = new Date();
  const reviewerSettings = {
    ...DEFAULT_PR_REVIEW_SETTINGS,
    backgroundAgentManaged: true,
    enabled: input.reviewerEnabled,
    environmentScope: 'all',
    environmentIds: [],
    authorReviewMode: 'specific',
    reviewAllPullRequestAuthors: input.reviewerReviewAllPullRequestAuthors,
    reviewOnCommit: input.reviewerReviewOnCommit,
    reviewDraftPrs: input.reviewerReviewDraftPrs,
    relayReviewResultsToTask: false,
    relayEligibleCreatorIds: [],
    approvePr: false,
  } satisfies PrReviewSettings;

  await db.transaction(async (tx) => {
    await tx
      .insert(deploymentSettings)
      .values({
        id: 'default',
        managerSlackChannelId: managerChannelResult.channelId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          managerSlackChannelId: managerChannelResult.channelId,
          updatedAt: now,
        },
      });

    await upsertAutomation(tx, {
      key: 'review_code',
      enabled: input.reviewerEnabled,
      settings: reviewerSettings,
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'conflict_resolver',
      enabled: input.conflictResolverFrequency !== 'off',
      schedule: {
        mode: input.conflictResolverFrequency,
      },
      instructions: normalizeOptionalText(input.conflictResolverInstructions),
      settings: {
        label: conflictResolverLabel,
        maxPrAgeDays: conflictResolverMaxPrAgeDays,
      },
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'slack_channel_auto_start',
      enabled: finalResolvedChannelAutoStartRows.length > 0,
      instructions:
        normalizeOptionalText(
          finalResolvedChannelAutoStartRows[0]?.instructions,
        ) ?? null,
      targets: finalResolvedChannelAutoStartRows.map((row, index) => ({
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: row.channelId,
        metadata: {
          order: index,
          ...(row.instructions ? { instructions: row.instructions } : {}),
          ...(row.launchMode !== DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE
            ? { launchMode: row.launchMode }
            : {}),
          ...(row.launchCriteria ? { launchCriteria: row.launchCriteria } : {}),
        },
      })),
      managedTargetKinds: ['slack_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'manager_stats',
      enabled: effectiveManagerStatsFrequency !== 'off',
      schedule: { mode: effectiveManagerStatsFrequency },
      targets: buildDestinationChannelTargets(
        managerStatsChannelResult.channelId,
        managerStatsDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'sentry_triage',
      enabled: sentryTriageFrequency !== 'off',
      schedule: { mode: sentryTriageFrequency },
      targets: [
        ...buildDestinationChannelTargets(
          sentryTriageChannelResult.channelId,
          sentryTriageDiscordResult.channelId,
        ),
        ...parseSentryProjectSlugs(sentryTriageProjectSlugs).map(
          (projectSlug): AutomationTarget => ({
            provider: 'sentry',
            targetKind: 'sentry_project',
            externalRef: projectSlug,
          }),
        ),
      ],
      managedTargetKinds: [
        'slack_channel',
        'discord_channel',
        'sentry_project',
      ],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'dependabot_triage',
      enabled: dependabotTriageFrequency !== 'off',
      schedule: { mode: dependabotTriageFrequency },
      targets: buildDestinationChannelTargets(
        dependabotTriageChannelResult.channelId,
        dependabotTriageDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'codeql_triage',
      enabled: codeqlTriageFrequency !== 'off',
      schedule: { mode: codeqlTriageFrequency },
      targets: buildDestinationChannelTargets(
        codeqlTriageChannelResult.channelId,
        codeqlTriageDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'security_auditor',
      enabled: securityAuditorFrequency !== 'off',
      schedule: { mode: securityAuditorFrequency },
      targets: buildDestinationChannelTargets(
        securityAuditorChannelResult.channelId,
        securityAuditorDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'code_quality_auditor',
      enabled: codeQualityAuditorFrequency !== 'off',
      schedule: { mode: codeQualityAuditorFrequency },
      targets: buildDestinationChannelTargets(
        codeQualityAuditorChannelResult.channelId,
        codeQualityAuditorDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'ci_failure_triage',
      enabled: ciFailureTriageFrequency !== 'off',
      schedule: { mode: ciFailureTriageFrequency },
      targets: buildDestinationChannelTargets(
        ciFailureTriageChannelResult.channelId,
        ciFailureTriageDiscordResult.channelId,
      ),
      managedTargetKinds: ['slack_channel', 'discord_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'suggester',
      enabled: effectiveSuggesterFrequency !== 'off',
      schedule: {
        mode: effectiveSuggesterFrequency,
      },
      instructions: effectiveSuggesterInstructions,
      settings: suggesterAutomationSettings,
      targets: buildSlackChannelTargets(suggesterChannelResult.channelId),
      managedTargetKinds: ['slack_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'announcer',
      enabled: effectiveAnnouncerFrequency !== 'off',
      schedule: {
        mode: effectiveAnnouncerFrequency,
      },
      instructions: normalizeOptionalText(input.announcerInstructions),
      targets: buildSlackChannelTargets(announcerChannelResult.channelId),
      managedTargetKinds: ['slack_channel'],
      updatedAt: now,
    });

    await upsertAutomation(tx, {
      key: 'platform_issue_alerts',
      enabled: platformIssueChannelResult.channelId != null,
      targets: buildSlackChannelTargets(platformIssueChannelResult.channelId),
      managedTargetKinds: ['slack_channel'],
      updatedAt: now,
    });
  });

  await syncSlackAutoStartChannelCache({
    shouldUpdate: true,
    enabled: finalResolvedChannelAutoStartRows.length > 0,
    channelIds: channelAutoStartChannelIds,
  });

  const updatedSettings = await getBackgroundAgentSettingsForDeployment();
  const updatedChannelAutoStartSlackChannelIds =
    updatedSettings.channelAutoStartSlackChannels.map(
      ({ channelId }) => channelId,
    );
  const hasSavedSlackMetadataTargets =
    updatedChannelAutoStartSlackChannelIds.length > 0 ||
    Boolean(updatedSettings.managerStatsSlackChannelId) ||
    Boolean(updatedSettings.suggesterSlackChannelId) ||
    Boolean(updatedSettings.announcerSlackChannelId) ||
    Boolean(updatedSettings.platformIssueSlackChannelId) ||
    Boolean(updatedSettings.sentryTriageSlackChannelId) ||
    Boolean(updatedSettings.dependabotTriageSlackChannelId) ||
    Boolean(updatedSettings.codeqlTriageSlackChannelId) ||
    Boolean(updatedSettings.securityAuditorSlackChannelId) ||
    Boolean(updatedSettings.codeQualityAuditorSlackChannelId) ||
    Boolean(updatedSettings.ciFailureTriageSlackChannelId);
  const postSaveSlackInstallation =
    notifier || !hasSavedSlackMetadataTargets
      ? null
      : await findActiveSlackInstallationForOrg();
  const postSaveNotifier =
    notifier ??
    (postSaveSlackInstallation
      ? new SlackNotifier(postSaveSlackInstallation.botAccessToken)
      : null);

  const slackChannelAccessWarnings = await getSlackChannelAccessWarnings({
    notifier: postSaveNotifier,
    channelAutoStartSlackChannelIds: updatedChannelAutoStartSlackChannelIds,
    managerStatsSlackChannelId: updatedSettings.managerStatsSlackChannelId,
    suggesterSlackChannelId: updatedSettings.suggesterSlackChannelId,
    announcerSlackChannelId: updatedSettings.announcerSlackChannelId,
    platformIssueSlackChannelId: updatedSettings.platformIssueSlackChannelId,
    sentryTriageSlackChannelId: updatedSettings.sentryTriageSlackChannelId,
    dependabotTriageSlackChannelId:
      updatedSettings.dependabotTriageSlackChannelId,
    codeqlTriageSlackChannelId: updatedSettings.codeqlTriageSlackChannelId,
    securityAuditorSlackChannelId:
      updatedSettings.securityAuditorSlackChannelId,
    codeQualityAuditorSlackChannelId:
      updatedSettings.codeQualityAuditorSlackChannelId,
    ciFailureTriageSlackChannelId:
      updatedSettings.ciFailureTriageSlackChannelId,
  });
  const slackChannelDisplayNames = await getSlackChannelDisplayNames({
    notifier: postSaveNotifier,
    channelAutoStartSlackChannelIds: updatedChannelAutoStartSlackChannelIds,
    managerSlackChannelId: updatedSettings.managerSlackChannelId,
    managerStatsSlackChannelId: updatedSettings.managerStatsSlackChannelId,
    suggesterSlackChannelId: updatedSettings.suggesterSlackChannelId,
    announcerSlackChannelId: updatedSettings.announcerSlackChannelId,
    platformIssueSlackChannelId: updatedSettings.platformIssueSlackChannelId,
    sentryTriageSlackChannelId: updatedSettings.sentryTriageSlackChannelId,
    dependabotTriageSlackChannelId:
      updatedSettings.dependabotTriageSlackChannelId,
    codeqlTriageSlackChannelId: updatedSettings.codeqlTriageSlackChannelId,
    securityAuditorSlackChannelId:
      updatedSettings.securityAuditorSlackChannelId,
    codeQualityAuditorSlackChannelId:
      updatedSettings.codeQualityAuditorSlackChannelId,
    ciFailureTriageSlackChannelId:
      updatedSettings.ciFailureTriageSlackChannelId,
  });
  for (const row of finalResolvedChannelAutoStartRows) {
    if (
      !slackChannelDisplayNames.channelAutoStartSlackChannels[row.channelId]
    ) {
      slackChannelDisplayNames.channelAutoStartSlackChannels[row.channelId] =
        row.channelName;
    }
  }
  if (
    !slackChannelDisplayNames.managerSlackChannel &&
    managerChannelResult.channelName
  ) {
    slackChannelDisplayNames.managerSlackChannel =
      managerChannelResult.channelName;
  }
  if (
    !slackChannelDisplayNames.managerStatsSlackChannel &&
    managerStatsChannelResult.channelName
  ) {
    slackChannelDisplayNames.managerStatsSlackChannel =
      managerStatsChannelResult.channelName;
  }
  const relayUsers = await listReviewerRelayUserRecords(
    auth,
    getRelayEligibleCreatorIds(updatedSettings.reviewCodeSettings),
  );

  // The reviewer mapping derives its managed-login list synchronously from
  // the cached configured app slug.
  await resolveConfiguredGitHubAppSlug();

  return {
    success: true,
    settings: maskSlackChannelAutoStartSettings(auth, updatedSettings),
    suggesterRoutingPreview,
    reviewer: updatedSettings.reviewCodeSettings
      ? mapReviewerSettingsToBackgroundSettings(
          updatedSettings.reviewCodeSettings,
          relayUsers,
        )
      : buildDefaultReviewerSettings(relayUsers),
    slackChannelAccessWarnings,
    slackChannelDisplayNames,
  };
}
