import type {
  FastAgentConversationRecord,
  FastAgentTurnActivity,
  TaskTitleCategory,
} from '@roomote/cloud-agents/server';
import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';

type TelegramTopicTitleProvider = Pick<
  TelegramCommunicationProvider,
  'editForumTopic' | 'resolveForumTopicIconCustomEmojiId'
>;

const DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES = ['💡', '💬', '📝'] as const;
const TELEGRAM_TOPIC_ICON_CANDIDATES_BY_CATEGORY: Record<
  TaskTitleCategory,
  readonly string[]
> = {
  general: DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES,
  security: ['🛃', '🪪', '👮‍♂️', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  fix: ['🦠', '🔎', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  test: ['✅', '🧪', '🔬', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  release: ['🎉', '🏁', '🏆', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  docs: ['📚', '📝', '💡', '💬'],
  ui: ['🎨', '💻', '📱', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  data: ['📈', '📉', '🧮', ...DEFAULT_TELEGRAM_TOPIC_ICON_CANDIDATES],
  communication: ['💬', '🗣', '📣', '💡', '📝'],
};

export function getTelegramTopicIconEmojiPreferences(
  category: TaskTitleCategory,
): readonly string[] {
  return TELEGRAM_TOPIC_ICON_CANDIDATES_BY_CATEGORY[category];
}

export async function syncFastAgentTelegramTopicTitleBestEffort(input: {
  provider: TelegramTopicTitleProvider;
  sessionId: string;
  channelId: string;
  threadId: string;
  category?: TaskTitleCategory | null;
  titleChanged?: boolean;
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
      const iconCustomEmojiId = input.category
        ? await input.provider
            .resolveForumTopicIconCustomEmojiId(
              getTelegramTopicIconEmojiPreferences(input.category),
            )
            .catch(() => undefined)
        : undefined;
      if (input.titleChanged === false && !iconCustomEmojiId) {
        return;
      }
      await input.provider.editForumTopic({
        channelId: input.channelId,
        threadId: input.threadId,
        ...(input.titleChanged === false ? {} : { name: title }),
        ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
      });

      if (input.titleChanged === false) {
        return;
      }

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
    metadata?: { category?: TaskTitleCategory | null; titleChanged?: boolean },
  ) => void;
} {
  let lastRequestedTitle: string | null | undefined;
  let lastRequestedCategory: TaskTitleCategory | null | undefined;
  let lastRequestedTitleChanged: boolean | undefined;
  let titleUpdate = Promise.resolve();

  return {
    ...input.activity,
    updateTitle(title, metadata) {
      const category = metadata?.category;
      const titleChanged = metadata?.titleChanged;
      if (
        !title ||
        (title === lastRequestedTitle &&
          category === lastRequestedCategory &&
          titleChanged === lastRequestedTitleChanged)
      )
        return;
      lastRequestedTitle = title;
      lastRequestedCategory = category;
      lastRequestedTitleChanged = titleChanged;
      titleUpdate = titleUpdate.then(() =>
        syncFastAgentTelegramTopicTitleBestEffort({
          ...input,
          category,
          titleChanged,
        }),
      );
    },
    async dispose() {
      await Promise.all([input.activity.dispose(), titleUpdate]);
    },
  } as T & {
    updateTitle: (
      title: string | null,
      metadata?: {
        category?: TaskTitleCategory | null;
        titleChanged?: boolean;
      },
    ) => void;
  };
}
