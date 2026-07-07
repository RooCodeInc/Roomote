import { replyToChatThread } from './chat-api-client.js';
import type { RoomoteConfig } from './types.js';

const postedProofThreads = new Set<string>();

export function resetPostedProofThreadsForTest(): void {
  postedProofThreads.clear();
}

function hasChatReplyContext(): boolean {
  return Boolean(
    (process.env.ROOMOTE_SLACK_CHANNEL?.trim() &&
      process.env.ROOMOTE_SLACK_THREAD_TS?.trim()) ||
    (process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim() &&
      process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim()),
  );
}

function isDeletedSlackThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes('409 Slack thread source message no longer exists');
}

function logDeletedSlackThreadSkip(logContext: string): void {
  console.warn(
    `[${logContext}] Skipping visual proof auto-post because the chat thread source message no longer exists`,
  );
}

function getProofThreadKey(): string | null {
  const channel = process.env.ROOMOTE_SLACK_CHANNEL?.trim();
  const threadTs = process.env.ROOMOTE_SLACK_THREAD_TS?.trim();

  if (channel && threadTs) {
    return `${channel}:${threadTs}`;
  }

  const provider = process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim();
  const communicationChannelId =
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim();

  if (provider && communicationChannelId) {
    const threadId = process.env.ROOMOTE_COMMUNICATION_THREAD_ID?.trim() ?? '';

    return `${provider}:${communicationChannelId}:${threadId}`;
  }

  return null;
}

export async function replyToChatWithVisualProof({
  roomoteConfig,
  text,
  imageArtifactIds = [],
  logContext,
  replyToChatThreadImpl,
}: {
  roomoteConfig?: RoomoteConfig | null;
  text?: string;
  imageArtifactIds?: string[];
  logContext: string;
  replyToChatThreadImpl?: typeof replyToChatThread;
}): Promise<boolean> {
  const config = roomoteConfig;
  if (!config || !hasChatReplyContext()) {
    return false;
  }

  const uniqueImageArtifactIds = [...new Set(imageArtifactIds)];
  const trimmedText = text?.trim() ?? '';

  if (!trimmedText && uniqueImageArtifactIds.length === 0) {
    return false;
  }

  const threadKey = getProofThreadKey();

  if (threadKey && postedProofThreads.has(threadKey)) {
    return false;
  }

  const reply = replyToChatThreadImpl ?? replyToChatThread;

  try {
    await reply(config, {
      ...(trimmedText ? { text: trimmedText } : {}),
      ...(uniqueImageArtifactIds.length > 0
        ? {
            images: uniqueImageArtifactIds.map((artifactId) => ({
              artifactId,
            })),
          }
        : {}),
    });

    if (threadKey) {
      postedProofThreads.add(threadKey);
    }

    return true;
  } catch (error) {
    if (isDeletedSlackThreadError(error)) {
      logDeletedSlackThreadSkip(logContext);
      return false;
    }

    if (uniqueImageArtifactIds.length > 0 && trimmedText) {
      console.warn(
        `[${logContext}] Failed to post visual proof image attachments; retrying with text only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      try {
        await reply(config, { text: trimmedText });
        return true;
      } catch (fallbackError) {
        if (isDeletedSlackThreadError(fallbackError)) {
          logDeletedSlackThreadSkip(logContext);
          return false;
        }

        console.error(
          `[${logContext}] Failed to post visual proof fallback: ${
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError)
          }`,
        );
      }
    }

    console.error(
      `[${logContext}] Failed to post visual proof: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
