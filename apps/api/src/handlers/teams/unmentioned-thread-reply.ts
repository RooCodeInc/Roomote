import {
  type TeamsActivity,
  type TeamsActivityCommunicationMetadata,
  isTeamsBotMentioned,
  isTeamsMessageActivity,
  isTeamsPersonalConversation,
  teamsActivityMentionsUserOtherThanBot,
} from '@roomote/communication/teams-activity';
import type {
  TeamsGraphMessage,
  TeamsGraphMessageMention,
} from '@roomote/communication/teams-graph-client';

import {
  compareNumericMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from '../shared/unmentioned-thread-reply.js';
import {
  findLatestTeamsThreadTaskRun,
  findTaskBackedTeamsAutomationReportRun,
} from './find-active-teams-run.js';

/**
 * Normalizes bot/application identifiers so Bot Framework ids (`28:<appId>`)
 * and Graph application ids (`<appId>`) compare equal.
 */
function normalizeTeamsAppIdentifier(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim().toLowerCase();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith('28:') ? trimmed.slice('28:'.length) : trimmed;
}

function isBotGraphMention(
  mention: TeamsGraphMessageMention,
  normalizedBotAppId: string,
): boolean {
  return (
    normalizeTeamsAppIdentifier(mention.applicationId) === normalizedBotAppId
  );
}

function isBotAuthoredGraphMessage(
  message: TeamsGraphMessage,
  normalizedBotAppId: string,
): boolean {
  return (
    normalizeTeamsAppIdentifier(message.authorApplicationId) ===
    normalizedBotAppId
  );
}

function isHumanAuthoredGraphMessage(message: TeamsGraphMessage): boolean {
  return Boolean(message.authorUserId) && !message.authorApplicationId;
}

function toSharedHistoryMessages(
  threadMessages: TeamsGraphMessage[],
  normalizedBotAppId: string,
): UnmentionedThreadHistoryMessage[] {
  return threadMessages.map((message) => {
    const isBot = isBotAuthoredGraphMessage(message, normalizedBotAppId);
    const isHuman = isHumanAuthoredGraphMessage(message);
    return {
      id: message.id,
      authorUserId: isHuman
        ? message.authorUserId
        : isBot
          ? normalizedBotAppId
          : null,
      isBot,
      mentionsBot: message.mentions.some((mention) =>
        isBotGraphMention(mention, normalizedBotAppId),
      ),
      mentionsSomebodyElse: message.mentions.some(
        (mention) =>
          !isBotGraphMention(mention, normalizedBotAppId) &&
          (Boolean(mention.applicationId) ||
            (Boolean(mention.userId) &&
              mention.userId !== message.authorUserId)),
      ),
    };
  });
}

/**
 * Decides whether a Teams channel-thread reply that does not mention the bot
 * should still route to the agent. Provider filters stay Teams-specific;
 * eligibility and interjection window rules come from the shared Slack/Discord
 * core in `handlers/shared/unmentioned-thread-reply`.
 *
 * Teams has no stored thread state, so the decision is computed from Graph
 * thread history each time. When history is unavailable (no delegated Graph
 * token, missing team metadata, or a failed read) the explicit-mention
 * requirement stays in place.
 */
export async function shouldRouteUnmentionedTeamsThreadReplyToAgent(params: {
  activity: TeamsActivity;
  metadata: TeamsActivityCommunicationMetadata;
  mappedUserId: string | null;
  botAppId: string | null;
  fetchThreadMessages: () => Promise<TeamsGraphMessage[] | null>;
}): Promise<boolean> {
  const { activity, metadata } = params;

  if (!isTeamsMessageActivity(activity)) {
    return false;
  }

  // Personal chats already route without a mention, and mentioned messages
  // are handled by the task-entry path.
  if (isTeamsPersonalConversation(activity) || isTeamsBotMentioned(activity)) {
    return false;
  }

  // Only replies inside an existing thread qualify. A top-level channel
  // message derives its thread id from its own activity id, so a distinct
  // thread id is the reliable reply signal.
  const threadId = metadata.communicationThreadId;
  const messageId = metadata.communicationMessageId;

  if (!threadId || !messageId || threadId === messageId) {
    return false;
  }

  const normalizedBotAppId = normalizeTeamsAppIdentifier(params.botAppId);
  const senderAadObjectId = activity.from?.aadObjectId?.trim();

  // Unmentioned routing needs a linked sender: the Graph history read runs
  // with the sender's delegated token, and ownership checks compare their
  // mapped Roomote user. Unlinked senders keep the explicit-mention flow so
  // the account-link prompt is never triggered by a drive-by reply.
  if (!normalizedBotAppId || !senderAadObjectId || !params.mappedUserId) {
    return false;
  }

  // Replies that mention somebody else are directed at that person, not the
  // bot.
  if (teamsActivityMentionsUserOtherThanBot(activity)) {
    return false;
  }

  const ownedThreadRun = await findLatestTeamsThreadTaskRun({
    conversationId: metadata.communicationChannelId,
    threadId,
  });
  const automationReportRun = await findTaskBackedTeamsAutomationReportRun({
    conversationId: metadata.communicationChannelId,
    threadId,
  });
  const taskBackedThreadRun = ownedThreadRun ?? automationReportRun;

  if (!taskBackedThreadRun) {
    return false;
  }

  const threadMessages = await params.fetchThreadMessages();

  // A real thread always contains at least its root message, so a missing or
  // empty history means it is unreliable. Require an explicit mention instead
  // of routing blind.
  if (!threadMessages || threadMessages.length === 0) {
    return false;
  }

  // Graph channel message ids match Bot Framework activity ids and encode
  // the send time in epoch milliseconds, so numeric comparison gives message
  // ordering.
  if (!Number.isFinite(Number(messageId))) {
    return false;
  }

  const isThreadRootAuthor = threadMessages.some(
    (message) =>
      message.id === threadId &&
      isHumanAuthoredGraphMessage(message) &&
      message.authorUserId === senderAadObjectId,
  );

  const decision = evaluateUnmentionedThreadReplyRouting({
    eventMessageId: messageId,
    senderUserId: senderAadObjectId,
    isThreadTaskOwner:
      Boolean(taskBackedThreadRun.userId) &&
      taskBackedThreadRun.userId === params.mappedUserId,
    isThreadRootAuthor,
    isAutomationReportThread: Boolean(automationReportRun),
    threadMessages: toSharedHistoryMessages(threadMessages, normalizedBotAppId),
    compareMessageIds: compareNumericMessageIds,
  });

  return decision.shouldRoute;
}
