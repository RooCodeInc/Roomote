import {
  getSlackThreadDisplayName,
  wrapSlackMessage,
  wrapSlackReplyingTo,
  wrapSlackTurnPolicy,
  wrapSlackThreadContext,
} from '@roomote/cloud-agents';

import {
  isTargetSlackBotMessage,
  splitThreadMessages,
} from './slack-thread-message-utils';
import type { SlackThreadMessage } from './types';
import {
  claimUndeliveredSlackThreadMessages,
  markSlackThreadMessagesDelivered,
  releaseClaimedSlackThreadMessages,
} from './slack-messages';
import { isSlackRoutingWaitReplyText } from './slack-system-messages';

interface SlackThreadContinuationPromptOptions {
  currentMessageTs: string;
  currentMessageText: string;
  resolveCurrentMessageText?: (
    claimedMessages: SlackThreadMessage[],
  ) => Promise<string>;
  fetchThreadMessages: () => Promise<SlackThreadMessage[]>;
  normalizeMessageText: (text: string) => Promise<string>;
  processMessageFiles?: (messages: SlackThreadMessage[]) => Promise<string[]>;
  getTrackedBotReply?: () => Promise<{ ts: string; text: string } | null>;
  isSlackDiverged?: boolean;
  botUserId?: string;
}

export interface SlackThreadContinuationPromptResult {
  currentMessageText: string;
  claimedImageUris: string[];
  formattedPrompt?: string;
  turnPolicy?: {
    reactionsAllowed: boolean;
  };
}

function compareSlackTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

function formatTrackerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageHasThreadDeliveryContent(message: SlackThreadMessage): boolean {
  return message.text.trim().length > 0 || (message.files?.length ?? 0) > 0;
}

export class SlackThreadDeliveryTracker {
  private readonly pendingDeliveredTimestamps = new Set<string>();
  private readonly claimedPendingTimestamps = new Set<string>();

  public constructor(
    private readonly channel: string,
    private readonly threadTs: string,
  ) {}

  public track(ts: string): void {
    this.pendingDeliveredTimestamps.add(ts);
  }

  public trackAll(timestamps: string[]): void {
    for (const ts of timestamps) {
      this.track(ts);
    }
  }

  public async buildContinuationPrompt({
    currentMessageTs,
    currentMessageText,
    resolveCurrentMessageText,
    fetchThreadMessages,
    normalizeMessageText,
    processMessageFiles,
    getTrackedBotReply,
    isSlackDiverged,
    botUserId,
  }: SlackThreadContinuationPromptOptions): Promise<SlackThreadContinuationPromptResult> {
    try {
      const threadMessages = await fetchThreadMessages();
      const earlierMessages = threadMessages.filter(
        (message) =>
          message.ts !== currentMessageTs &&
          compareSlackTimestamps(message.ts, currentMessageTs) < 0 &&
          messageHasThreadDeliveryContent(message),
      );
      const promptRelevantEarlierMessages = earlierMessages.filter(
        (message) =>
          !(
            isTargetSlackBotMessage(message, botUserId) &&
            isSlackRoutingWaitReplyText(message.text)
          ),
      );
      const { latestOwnBotReply } = splitThreadMessages(
        promptRelevantEarlierMessages.filter(
          (message) => message.text.trim().length > 0,
        ),
        botUserId,
      );
      const trackedBotReply = await getTrackedBotReply?.();
      const trackedBotMessage =
        trackedBotReply &&
        trackedBotReply.text.trim().length > 0 &&
        compareSlackTimestamps(trackedBotReply.ts, currentMessageTs) < 0
          ? promptRelevantEarlierMessages.find(
              (message) =>
                message.ts === trackedBotReply.ts &&
                isTargetSlackBotMessage(message, botUserId) &&
                message.text.trim().length > 0,
            )
          : undefined;
      const validTrackedBotReply =
        trackedBotReply && trackedBotMessage
          ? {
              ts: trackedBotReply.ts,
              text: trackedBotReply.text,
              displayName: getSlackThreadDisplayName(trackedBotMessage),
            }
          : null;
      const replyingToMessage =
        validTrackedBotReply ||
        (latestOwnBotReply && {
          ts: latestOwnBotReply.ts,
          text: latestOwnBotReply.text,
          displayName: latestOwnBotReply.displayName,
        });
      const contextCandidateMessages = promptRelevantEarlierMessages.filter(
        (message) => {
          if (isTargetSlackBotMessage(message, botUserId)) {
            return (message.files?.length ?? 0) > 0;
          }

          return message.ts !== replyingToMessage?.ts;
        },
      );

      const claimedContextTimestamps =
        contextCandidateMessages.length === 0
          ? []
          : await claimUndeliveredSlackThreadMessages(
              this.channel,
              this.threadTs,
              contextCandidateMessages.map((message) => message.ts),
            );

      if (claimedContextTimestamps.length > 0) {
        this.trackAll(claimedContextTimestamps);

        for (const ts of claimedContextTimestamps) {
          this.claimedPendingTimestamps.add(ts);
        }
      }

      const claimedSet = new Set(claimedContextTimestamps);
      const claimedMessages = await Promise.all(
        contextCandidateMessages
          .filter((message) => claimedSet.has(message.ts))
          .map(async (message) => ({
            ...message,
            text:
              message.text.trim().length > 0
                ? await normalizeMessageText(message.text)
                : message.text,
          })),
      );
      const claimedImageUris = processMessageFiles
        ? await processMessageFiles(claimedMessages)
        : [];
      const resolvedCurrentMessageText = resolveCurrentMessageText
        ? await resolveCurrentMessageText(claimedMessages)
        : currentMessageText;
      const hasPriorBotReply = Boolean(replyingToMessage);
      const normalizedLatestBotReply =
        isSlackDiverged !== false &&
        replyingToMessage &&
        wrapSlackReplyingTo({
          displayName: replyingToMessage.displayName,
          text: await normalizeMessageText(replyingToMessage.text),
          ts: replyingToMessage.ts,
        });
      const contextBlock = wrapSlackThreadContext(
        claimedMessages
          .filter(
            (message) =>
              message.text.trim().length > 0 &&
              !isTargetSlackBotMessage(message, botUserId),
          )
          .map((message) => ({
            displayName: getSlackThreadDisplayName(message),
            text: message.text,
            ts: message.ts,
          })),
      );
      const currentTurnPolicyBlock = wrapSlackTurnPolicy({
        reactionsAllowed: hasPriorBotReply,
        preferEmojiAck: hasPriorBotReply,
      });
      const turnPolicy = {
        reactionsAllowed: hasPriorBotReply,
      };
      const currentMessageBlock = wrapSlackMessage(resolvedCurrentMessageText, {
        ts: currentMessageTs,
      });

      if (!contextBlock && !normalizedLatestBotReply) {
        return {
          currentMessageText: resolvedCurrentMessageText,
          claimedImageUris,
          turnPolicy,
          formattedPrompt: [currentTurnPolicyBlock, currentMessageBlock].join(
            '\n\n',
          ),
        };
      }

      return {
        currentMessageText: resolvedCurrentMessageText,
        claimedImageUris,
        turnPolicy,
        formattedPrompt: [
          contextBlock,
          normalizedLatestBotReply,
          currentTurnPolicyBlock,
          currentMessageBlock,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    } catch (error) {
      await this.rollback().catch(() => {});
      console.error(
        `[SlackWebhook] Failed to build incremental Slack thread context: ${formatTrackerError(error)}`,
      );
      return {
        currentMessageText,
        claimedImageUris: [],
        turnPolicy: {
          reactionsAllowed: false,
        },
      };
    }
  }

  public async commit(): Promise<void> {
    const pendingTimestamps = [...this.pendingDeliveredTimestamps];

    if (pendingTimestamps.length === 0) {
      return;
    }

    await markSlackThreadMessagesDelivered(
      this.channel,
      this.threadTs,
      pendingTimestamps,
    );

    for (const ts of pendingTimestamps) {
      this.pendingDeliveredTimestamps.delete(ts);
      this.claimedPendingTimestamps.delete(ts);
    }
  }

  public async rollback(): Promise<void> {
    const claimedPendingTimestamps = [...this.claimedPendingTimestamps];

    if (claimedPendingTimestamps.length === 0) {
      return;
    }

    await releaseClaimedSlackThreadMessages(
      this.channel,
      this.threadTs,
      claimedPendingTimestamps,
    );

    for (const ts of claimedPendingTimestamps) {
      this.claimedPendingTimestamps.delete(ts);
      this.pendingDeliveredTimestamps.delete(ts);
    }
  }
}
