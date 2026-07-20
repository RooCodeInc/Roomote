import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import type { DiscordAttachment } from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import {
  wrapCommunicationMessage,
  type QueuedCommunicationMessage,
} from '@roomote/types';

import { processDiscordAttachments } from './attachments.js';
import {
  claimUndeliveredDiscordThreadMessages,
  markDiscordThreadMessagesDelivered,
  releaseClaimedDiscordThreadMessages,
} from './thread-delivery.js';

export type DiscordThreadHistoryMessage = {
  id: string;
  user: string;
  username?: string;
  text: string;
  botId?: string;
  attachments: DiscordAttachment[];
};

function escapeDiscordPromptContent(value: string): string {
  return value
    .replaceAll('&', '&' + 'amp;')
    .replaceAll('<', '&' + 'lt;')
    .replaceAll('>', '&' + 'gt;');
}

function compareDiscordSnowflakes(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  } catch {
    return left.localeCompare(right);
  }
}

function messageDisplayName(message: DiscordThreadHistoryMessage): string {
  return (message.username?.trim() || message.user || 'Unknown').trim();
}

function messageHasThreadDeliveryContent(
  message: DiscordThreadHistoryMessage,
): boolean {
  return message.text.trim().length > 0 || message.attachments.length > 0;
}

function formatDiscordThreadContextEntry(
  message: DiscordThreadHistoryMessage,
): string | null {
  const displayName = messageDisplayName(message);
  if (!displayName) return null;

  const text = message.text.trim();
  const attachmentNames = message.attachments
    .map((attachment) => attachment.filename?.trim())
    .filter((name): name is string => Boolean(name));
  const attachmentLabel =
    attachmentNames.length > 0
      ? `[attached: ${attachmentNames.join(', ')}]`
      : '';
  const body = [text, attachmentLabel].filter(Boolean).join(' ');
  if (!body) return null;

  return `${escapeDiscordPromptContent(displayName)}: ${escapeDiscordPromptContent(body)}`;
}

export function formatDiscordThreadContext(input: {
  messages: DiscordThreadHistoryMessage[];
  currentMessageId: string;
}): string | undefined {
  const earlier = input.messages.filter(
    (message) =>
      compareDiscordSnowflakes(message.id, input.currentMessageId) < 0 &&
      messageHasThreadDeliveryContent(message),
  );
  if (earlier.length === 0) return undefined;

  const entries = earlier
    .map((message) => formatDiscordThreadContextEntry(message))
    .filter((entry): entry is string => entry !== null);
  if (entries.length === 0) return undefined;

  return `<thread_context>\n${entries.join('\n\n')}\n</thread_context>`;
}

function formatDiscordReplyingTo(input: {
  displayName: string;
  text: string;
  messageId: string;
}): string {
  return `<replying_to ts="${escapeDiscordPromptContent(input.messageId)}">\n${escapeDiscordPromptContent(input.displayName)}: ${escapeDiscordPromptContent(input.text.trim())}\n</replying_to>`;
}

export function toDiscordAttachmentsFromHistory(
  messages: DiscordThreadHistoryMessage[],
  options?: { excludeMessageId?: string },
): DiscordAttachment[] {
  const attachments: DiscordAttachment[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (options?.excludeMessageId && message.id === options.excludeMessageId) {
      continue;
    }
    for (const attachment of message.attachments) {
      if (!attachment.url || seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push(attachment);
    }
  }
  return attachments;
}

function toDiscordThreadHistoryMessage(message: {
  id: string;
  user: string;
  username?: string;
  text: string;
  botId?: string;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
}): DiscordThreadHistoryMessage {
  return {
    id: message.id,
    user: message.user,
    ...(message.username ? { username: message.username } : {}),
    text: message.text,
    ...(message.botId ? { botId: message.botId } : {}),
    attachments: (message.files ?? [])
      .filter((file) => Boolean(file.url?.trim()))
      .map((file) => ({
        id: file.id,
        filename: file.name,
        size: file.size,
        url: file.url!,
        ...(file.mimeType && file.mimeType !== 'application/octet-stream'
          ? { content_type: file.mimeType }
          : {}),
      })),
  };
}

export async function fetchDiscordThreadHistoryBestEffort(input: {
  provider: DiscordCommunicationProvider;
  channelId: string;
  /**
   * Parent channel of a thread. Threads anchored to a channel message share
   * their id with the starter message, which lives in the parent channel and
   * never appears in the thread's own listing; pass the parent so the starter
   * can be recovered from there.
   */
  parentChannelId?: string;
}): Promise<DiscordThreadHistoryMessage[]> {
  // Discord returns newest-first pages of up to 100. Walk backward with `before`
  // so a long thread still becomes agent context (Slack fetches full reply chains).
  const MAX_THREAD_HISTORY_MESSAGES = 500;
  const PAGE_SIZE = 100;
  try {
    const collected: DiscordThreadHistoryMessage[] = [];
    let before: string | undefined;
    while (collected.length < MAX_THREAD_HISTORY_MESSAGES) {
      const result = await input.provider.fetchChannelMessages({
        channelId: input.channelId,
        ...(before ? { latest: before } : {}),
      });
      if (result.messages.length === 0) break;

      const page = result.messages.map(toDiscordThreadHistoryMessage);

      // Pages arrive newest-last after provider reverse; prepend so overall
      // order stays oldest -> newest while we walk earlier pages.
      collected.unshift(...page);
      if (result.messages.length < PAGE_SIZE) break;
      before = page[0]?.id;
      if (!before) break;
    }

    const capped =
      collected.length > MAX_THREAD_HISTORY_MESSAGES
        ? collected.slice(-MAX_THREAD_HISTORY_MESSAGES)
        : collected;

    // Forum posts carry their starter inside the thread listing; message-
    // anchored threads never do, so recover it from the parent channel.
    if (
      input.parentChannelId &&
      !collected.some((message) => message.id === input.channelId)
    ) {
      // Independently best-effort: a missing or unreadable starter must not
      // discard the thread history that was already collected.
      const starter = await Promise.resolve()
        .then(() =>
          input.provider.fetchMessage({
            channelId: input.parentChannelId!,
            messageId: input.channelId,
          }),
        )
        .catch(() => null);
      if (starter) {
        capped.unshift(toDiscordThreadHistoryMessage(starter));
      }
    }

    return capped;
  } catch (error) {
    console.warn(
      `[discord] Failed to fetch thread history for channel ${input.channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

export async function markDiscordThreadHistoryDelivered(input: {
  channelId: string;
  messageIds: string[];
}): Promise<void> {
  try {
    await markDiscordThreadMessagesDelivered(input.channelId, input.messageIds);
  } catch (error) {
    console.warn(
      `[discord] Failed to mark thread history delivered for ${input.channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

type DiscordContinuationPromptResult = {
  message: QueuedCommunicationMessage;
  claimedMessageIds: string[];
  channelId: string;
};

/**
 * Build a Slack-parity Discord follow-up prompt: undelivered earlier human/bot
 * side messages in `<thread_context>`, latest Roomote reply in `<replying_to>`,
 * prior supported attachments as images/text, and the current turn wrapped as
 * a communication_message.
 */
export async function buildDiscordContinuationPrompt(input: {
  provider: DiscordCommunicationProvider;
  channelId: string;
  /** Parent channel of a thread; lets history recover the starter message. */
  parentChannelId?: string;
  botUserId?: string;
  queuedMessage: QueuedCommunicationMessage;
  /**
   * When true (default), only messages not yet claimed against this conversation
   * enter thread_context. Initial task launch should mark the starter history
   * delivered so follow-ups do not re-inject it.
   */
  claimUndelivered?: boolean;
}): Promise<DiscordContinuationPromptResult> {
  const claimUndelivered = input.claimUndelivered !== false;
  const history = await fetchDiscordThreadHistoryBestEffort({
    provider: input.provider,
    channelId: input.channelId,
    ...(input.parentChannelId
      ? { parentChannelId: input.parentChannelId }
      : {}),
  });

  const earlier = history.filter(
    (message) =>
      compareDiscordSnowflakes(message.id, input.queuedMessage.ts) < 0 &&
      messageHasThreadDeliveryContent(message),
  );

  const ownBotEarlier = earlier.filter(
    (message) =>
      input.botUserId &&
      message.botId === input.botUserId &&
      message.text.trim().length > 0,
  );
  const latestOwnBotReply =
    ownBotEarlier.length > 0
      ? ownBotEarlier[ownBotEarlier.length - 1]
      : undefined;

  // Match Slack: own bot text lives in <replying_to>, but attachment-carrying
  // Roomote replies (including the latest) must still be claimable so their
  // images/documents reach the next user turn.
  const contextCandidates = earlier.filter((message) => {
    if (input.botUserId && message.botId === input.botUserId) {
      return message.attachments.length > 0;
    }
    return messageHasThreadDeliveryContent(message);
  });

  let claimedIds: string[] = [];
  if (claimUndelivered) {
    try {
      claimedIds = await claimUndeliveredDiscordThreadMessages(
        input.channelId,
        contextCandidates.map((message) => message.id),
      );
    } catch (error) {
      console.warn(
        `[discord] Failed to claim undelivered thread messages for ${input.channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      claimedIds = contextCandidates.map((message) => message.id);
    }
  } else {
    claimedIds = contextCandidates.map((message) => message.id);
  }

  const claimedSet = new Set(claimedIds);
  const claimedMessages = contextCandidates.filter((message) =>
    claimedSet.has(message.id),
  );

  const historyAttachments = toDiscordAttachmentsFromHistory(claimedMessages);
  const processedAttachments = historyAttachments.length
    ? await processDiscordAttachments(historyAttachments)
    : { images: [], attachmentTexts: [], warnings: [] };
  for (const warning of processedAttachments.warnings) {
    console.warn(`[discord] Follow-up thread attachment warning: ${warning}`);
  }

  // Keep own-bot text out of <thread_context> (it is already in <replying_to>
  // for the latest reply). Attachment filenames from claimed human/side
  // messages still appear; bot attachments still process via files above.
  const threadContextMessages = claimedMessages
    .filter(
      (message) => !(input.botUserId && message.botId === input.botUserId),
    )
    .concat({
      id: input.queuedMessage.ts,
      user: input.queuedMessage.user,
      text: input.queuedMessage.text,
      attachments: [],
    });
  const threadContext = formatDiscordThreadContext({
    messages: threadContextMessages,
    currentMessageId: input.queuedMessage.ts,
  });

  const replyingToBlock =
    latestOwnBotReply &&
    formatDiscordReplyingTo({
      displayName: messageDisplayName(latestOwnBotReply),
      text: latestOwnBotReply.text,
      messageId: latestOwnBotReply.id,
    });

  const hasPriorBotReply = Boolean(latestOwnBotReply);
  const turnPolicy = {
    reactionsAllowed: hasPriorBotReply,
  };

  const textWithAttachments = appendAttachmentTextsToPromptText({
    text: input.queuedMessage.text,
    attachmentTexts: processedAttachments.attachmentTexts,
  });
  const allImages = [
    ...(input.queuedMessage.images ?? []),
    ...processedAttachments.images,
  ];

  const messageWithPolicy: QueuedCommunicationMessage = {
    ...input.queuedMessage,
    text: textWithAttachments,
    turnPolicy,
    ...(allImages.length ? { images: allImages } : {}),
  };

  const currentMessageBlock = wrapCommunicationMessage(
    'discord',
    messageWithPolicy,
  );

  const formattedPrompt = [threadContext, replyingToBlock, currentMessageBlock]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');

  // Always set formattedPrompt so turn policy and wrapper shape match Slack
  // follow-ups even when no prior thread_context was claimed.
  return {
    message: {
      ...messageWithPolicy,
      formattedPrompt,
    },
    claimedMessageIds: claimedIds,
    channelId: input.channelId,
  };
}

export async function releaseDiscordContinuationClaim(
  claim: Pick<
    DiscordContinuationPromptResult,
    'channelId' | 'claimedMessageIds'
  > | null,
): Promise<void> {
  if (!claim || claim.claimedMessageIds.length === 0) {
    return;
  }
  try {
    await releaseClaimedDiscordThreadMessages(
      claim.channelId,
      claim.claimedMessageIds,
    );
  } catch (error) {
    console.warn(
      `[discord] Failed to release claimed thread messages for ${claim.channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
