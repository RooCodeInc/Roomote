import type {
  FastAgentConversationRecord,
  FastAgentTurnActivity,
} from '@roomote/cloud-agents/server';
import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';

type TelegramTopicTitleProvider = Pick<
  TelegramCommunicationProvider,
  'editForumTopic' | 'resolveForumTopicIconCustomEmojiId'
>;

export async function syncFastAgentTelegramTopicTitleBestEffort(input: {
  provider: TelegramTopicTitleProvider;
  sessionId: string;
  channelId: string;
  threadId: string;
  emoji?: string | null;
  resolveSession: () => Promise<FastAgentConversationRecord | null>;
}): Promise<void> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await input.resolveSession();
      if (
        !session?.title ||
        session.conversation.surface !== 'telegram' ||
        session.conversation.replyTarget.channelId !== input.channelId ||
        session.conversation.replyTarget.threadId !== input.threadId
      ) {
        return;
      }

      const title = buildCommunicationTaskThreadName(session.title);
      const iconCustomEmojiId = input.emoji
        ? await input.provider
            .resolveForumTopicIconCustomEmojiId([input.emoji])
            .catch(() => undefined)
        : undefined;
      await input.provider.editForumTopic({
        channelId: input.channelId,
        threadId: input.threadId,
        name: title,
        ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
      });

      const latest = await input.resolveSession();
      if (
        !latest?.title ||
        buildCommunicationTaskThreadName(latest.title) === title
      ) {
        return;
      }
    }
  } catch (error) {
    console.warn(
      `[Fast Agent] Failed to sync Telegram topic title for session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function addFastAgentTelegramTopicTitleSync<
  T extends FastAgentTurnActivity & { reassert: () => void },
>(input: {
  activity: T;
  provider: TelegramTopicTitleProvider;
  sessionId: string;
  channelId: string;
  threadId: string;
  resolveSession: () => Promise<FastAgentConversationRecord | null>;
}): T & {
  updateTitle: (
    title: string | null,
    metadata?: { emoji?: string | null },
  ) => void;
} {
  let lastRequestedTitle: string | null | undefined;
  let lastRequestedEmoji: string | null | undefined;
  let titleUpdate = Promise.resolve();

  return {
    ...input.activity,
    updateTitle(title, metadata) {
      const emoji = metadata?.emoji;
      if (
        !title ||
        (title === lastRequestedTitle && emoji === lastRequestedEmoji)
      )
        return;
      lastRequestedTitle = title;
      lastRequestedEmoji = emoji;
      titleUpdate = titleUpdate.then(() =>
        syncFastAgentTelegramTopicTitleBestEffort({ ...input, emoji }),
      );
    },
    async dispose() {
      await Promise.all([input.activity.dispose(), titleUpdate]);
    },
  } as T & {
    updateTitle: (
      title: string | null,
      metadata?: { emoji?: string | null },
    ) => void;
  };
}
