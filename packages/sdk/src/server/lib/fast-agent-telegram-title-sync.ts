import type {
  FastAgentConversationRecord,
  FastAgentTurnActivity,
  TelegramTopicIconEmoji,
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
  iconEmoji?: TelegramTopicIconEmoji | null;
  titleChanged?: boolean;
  resolveSession: () => Promise<FastAgentConversationRecord | null>;
}): Promise<boolean> {
  let updated = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await input.resolveSession();
      if (
        !session?.title ||
        session.conversation.surface !== 'telegram' ||
        session.conversation.replyTarget.channelId !== input.channelId ||
        session.conversation.replyTarget.threadId !== input.threadId
      ) {
        return updated;
      }

      const title = buildCommunicationTaskThreadName(session.title);
      const iconCustomEmojiId = input.iconEmoji
        ? await input.provider
            .resolveForumTopicIconCustomEmojiId([input.iconEmoji])
            .catch(() => undefined)
        : undefined;
      if (input.titleChanged === false && !iconCustomEmojiId) {
        return updated;
      }
      await input.provider.editForumTopic({
        channelId: input.channelId,
        threadId: input.threadId,
        ...(input.titleChanged === false ? {} : { name: title }),
        ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
      });
      updated = true;

      if (input.titleChanged === false) {
        return updated;
      }

      const latest = await input.resolveSession();
      if (
        !latest?.title ||
        buildCommunicationTaskThreadName(latest.title) === title
      ) {
        return updated;
      }
    }
  } catch (error) {
    console.warn(
      `[Fast Agent] Failed to sync Telegram topic title for session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return updated;
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
    metadata?: {
      iconEmoji?: TelegramTopicIconEmoji | null;
      titleChanged?: boolean;
    },
  ) => void;
} {
  let lastRequestedTitle: string | null | undefined;
  let lastRequestedIconEmoji: TelegramTopicIconEmoji | null | undefined;
  let lastRequestedTitleChanged: boolean | undefined;
  let titleUpdate = Promise.resolve();

  return {
    ...input.activity,
    updateTitle(title, metadata) {
      const iconEmoji = metadata?.iconEmoji;
      const titleChanged = metadata?.titleChanged;
      if (
        !title ||
        (title === lastRequestedTitle &&
          iconEmoji === lastRequestedIconEmoji &&
          titleChanged === lastRequestedTitleChanged)
      )
        return;
      lastRequestedTitle = title;
      lastRequestedIconEmoji = iconEmoji;
      lastRequestedTitleChanged = titleChanged;
      titleUpdate = titleUpdate.then(async () => {
        const updated = await syncFastAgentTelegramTopicTitleBestEffort({
          ...input,
          iconEmoji,
          titleChanged,
        });
        if (updated) input.activity.reassert();
      });
    },
    async dispose() {
      await Promise.all([input.activity.dispose(), titleUpdate]);
    },
  } as T & {
    updateTitle: (
      title: string | null,
      metadata?: {
        iconEmoji?: TelegramTopicIconEmoji | null;
        titleChanged?: boolean;
      },
    ) => void;
  };
}
