import type { CommunicationMessageButton } from '@roomote/communication';
import { buildSetupSuggestionsInlineIntroText } from '@roomote/communication/chat-messages';
import {
  and,
  claimWorkItem,
  db,
  eq,
  trackedMessages,
} from '@roomote/db/server';
import {
  enqueueDiscordSuggestedTasksOnboardingFollowup,
  findDiscordDefaultDestination,
  findDiscordUserMappingByRoomoteUserId,
  type DiscordDefaultDestination,
} from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import {
  buildInlineSuggestionIdeaLines,
  buildSharedMessageSuggestionRows,
  hasTrackedSetupSuggestionMessages,
  insertSetupSuggestionMessageRows,
  MAX_SETUP_SUGGESTIONS,
  scheduleSuggestedTasksFollowupBestEffort,
  type SetupSuggestionSummary,
} from '../tasks/setup-suggestion-lifecycle.js';
import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
import { resolveDiscordProvider } from './provider.js';

const SUGGESTION_CALLBACK_PREFIX = 'idea:';
const DISCORD_MAX_INITIAL_POST_LENGTH = 2_000;
const DISCORD_SETUP_START_INSTRUCTION =
  'Choose a Start button below, or just describe your own.';

function buildDiscordSuggestionCallbackData(suggestionId: string): string {
  return `${SUGGESTION_CALLBACK_PREFIX}${suggestionId}`;
}

function fitDiscordInitialPost(text: string): string {
  if (text.length <= DISCORD_MAX_INITIAL_POST_LENGTH) {
    return text;
  }
  return `${text.slice(0, DISCORD_MAX_INITIAL_POST_LENGTH - 1).trimEnd()}…`;
}

type DiscordSuggestionLaunchClaim = {
  id: string;
  title: string;
  brief: string | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId?: string | null;
  /** The card's explicit launch target, kept even when its environment FK was cleared. */
  launchTarget?: string;
  usesRouterLaunch: boolean;
  /** The scan or onboarding task that produced the suggestion. */
  sourceTaskId: string | null;
  launchClaimedAt: Date;
};

/**
 * Posts setup suggestions to their own Discord thread/forum post. The
 * destination may be pinned to the setup handoff; otherwise the deployment's
 * selected Discord default is used.
 */
export async function postSetupTaskSuggestionsToDiscord(params: {
  sourceTaskId: string;
  createdByUserId: string | null;
  suggestions: SetupSuggestionSummary[];
  destination?: DiscordDefaultDestination | null;
}): Promise<boolean> {
  const { sourceTaskId, createdByUserId, suggestions } = params;
  if (!createdByUserId || suggestions.length === 0) {
    return false;
  }

  if (await hasTrackedSetupSuggestionMessages(sourceTaskId)) {
    apiLogger.debug(
      `[SetupSuggestionLifecycle] Skip Discord suggestion post because tracked messages already exist for sourceTaskId=${sourceTaskId}`,
    );
    return true;
  }

  let provider: Awaited<ReturnType<typeof resolveDiscordProvider>>['provider'];
  try {
    ({ provider } = await resolveDiscordProvider());
  } catch {
    return false;
  }

  // Slack model: onboarding suggestions belong in the shared channel where
  // the team can see and start them. The setup user's DM is only a fallback
  // for deployments that have not picked a default channel yet.
  let destination = params.destination ?? null;
  if (!destination) {
    destination = await findDiscordDefaultDestination();
  }
  let directMessage: Awaited<
    ReturnType<typeof provider.createDirectMessage>
  > | null = null;
  if (!destination) {
    try {
      const mapping =
        await findDiscordUserMappingByRoomoteUserId(createdByUserId);
      directMessage = mapping
        ? await provider.createDirectMessage(mapping.discordUserId)
        : null;
    } catch {
      return false;
    }
  }
  if (!destination && !directMessage) {
    return false;
  }

  const limitedSuggestions = suggestions.slice(0, MAX_SETUP_SUGGESTIONS);
  const introLines = [
    buildSetupSuggestionsInlineIntroText({
      startInstruction: DISCORD_SETUP_START_INSTRUCTION,
    }),
    '',
    ...buildInlineSuggestionIdeaLines(limitedSuggestions),
  ];
  const buttons: CommunicationMessageButton[][] = limitedSuggestions.map(
    (suggestion, index) => [
      {
        text: `▶️ Start idea ${index + 1}`,
        callbackData: buildDiscordSuggestionCallbackData(suggestion.id),
      },
    ],
  );
  const initialText = fitDiscordInitialPost(introLines.join('\n'));
  const thread = destination
    ? await provider.createTaskThread({
        channelId: destination.channelId,
        name: buildCommunicationTaskThreadName('Suggested tasks'),
        initialText,
        buttons,
      })
    : null;
  const directMessagePost = directMessage
    ? await provider.postMessage({
        channelId: directMessage.id,
        text: initialText,
        textFormat: 'markdown',
        buttons,
      })
    : null;
  const deliveryChannelId = thread?.channelId ?? directMessage?.id;
  const introMessageId = thread?.messageId ?? directMessagePost?.messageId;
  if (!introMessageId || !deliveryChannelId) {
    return false;
  }

  await insertSetupSuggestionMessageRows(
    buildSharedMessageSuggestionRows({
      surface: 'discord',
      messageId: introMessageId,
      channelId: deliveryChannelId,
      sourceTaskId,
      createdByUserId,
      suggestions: limitedSuggestions,
    }),
  );

  apiLogger.debug(
    `[SetupSuggestionLifecycle] Published ${limitedSuggestions.length} setup suggestions to Discord ${destination ? `thread ${deliveryChannelId}` : `DM ${deliveryChannelId}`} for sourceTaskId=${sourceTaskId}`,
  );

  await scheduleSuggestedTasksFollowupBestEffort({
    surfaceLabel: 'Discord',
    sourceTaskId,
    enqueue: () =>
      enqueueDiscordSuggestedTasksOnboardingFollowup({
        guildId: destination?.guildId ?? null,
        channelId: destination?.channelId ?? deliveryChannelId,
        threadId: deliveryChannelId,
        introMessageId,
        sourceTaskId,
      }),
  });

  return true;
}

/**
 * Claims a Discord suggestion button only when the backing card was posted in
 * the interaction's current thread. This prevents copied component ids from
 * launching work from another channel or guild.
 */
export async function claimDiscordSuggestionLaunch(input: {
  suggestionId: string;
  channelId: string;
}): Promise<DiscordSuggestionLaunchClaim | null> {
  const trackedCard = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.surface, 'discord'),
      eq(trackedMessages.kind, 'suggestion_card'),
      eq(trackedMessages.channelId, input.channelId),
      eq(trackedMessages.workItemId, input.suggestionId),
    ),
    columns: { id: true, metadata: true },
  });

  if (!trackedCard) {
    return null;
  }

  const claimed = await claimWorkItem(db, { id: input.suggestionId });
  if (!claimed) {
    return null;
  }

  // Cards marked launchRouting: 'router' are presentation-only chat-reply
  // suggestions; drop their pinned launch metadata so the task router selects
  // the workspace. Unmarked cards (scan and setup) keep their verified
  // targets.
  const routed = trackedCard.metadata?.launchRouting === 'router';

  return {
    id: claimed.id,
    title: claimed.title,
    brief: claimed.brief,
    investigationContext: routed ? null : claimed.investigationContext,
    targetRepositoryFullName: routed ? null : claimed.targetRepositoryFullName,
    targetEnvironmentId: routed ? null : claimed.targetEnvironmentId,
    ...(!routed && typeof trackedCard.metadata?.launchTarget === 'string'
      ? { launchTarget: trackedCard.metadata.launchTarget }
      : {}),
    usesRouterLaunch: routed,
    sourceTaskId: claimed.sourceTaskId,
    launchClaimedAt: claimed.launchClaimedAt,
  };
}
