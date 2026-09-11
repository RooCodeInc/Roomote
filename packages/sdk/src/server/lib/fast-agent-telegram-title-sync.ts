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

const DEFAULT_TELEGRAM_TOPIC_ICON_EMOJIS = ['💡', '💬', '📝'] as const;
const TELEGRAM_TOPIC_ICON_RULES: ReadonlyArray<{
  pattern: RegExp;
  emojis: readonly string[];
}> = [
  { pattern: /\b(security|auth|permission|vulnerab)/iu, emojis: ['🔒'] },
  { pattern: /\b(bug|fix|error|fail|regression|crash)/iu, emojis: ['🐞', '🛠'] },
  { pattern: /\b(test|spec|validation|verify|ci)\b/iu, emojis: ['✅', '🧪'] },
  { pattern: /\b(deploy|release|ship|launch)\b/iu, emojis: ['🚀'] },
  { pattern: /\b(doc|docs|documentation|guide|readme)\b/iu, emojis: ['📚'] },
  { pattern: /\b(ui|ux|design|frontend|interface)\b/iu, emojis: ['🎨'] },
  { pattern: /\b(data|database|analytics|metric|report)\b/iu, emojis: ['📊'] },
  {
    pattern: /\b(telegram|slack|discord|teams|email|integration)\b/iu,
    emojis: ['💬'],
  },
];

export function getTelegramTopicIconEmojiPreferences(
  title: string,
): readonly string[] {
  const match = TELEGRAM_TOPIC_ICON_RULES.find(({ pattern }) =>
    pattern.test(title),
  );
  return match
    ? [...match.emojis, ...DEFAULT_TELEGRAM_TOPIC_ICON_EMOJIS]
    : DEFAULT_TELEGRAM_TOPIC_ICON_EMOJIS;
}

export async function syncFastAgentTelegramTopicTitleBestEffort(input: {
  provider: TelegramTopicTitleProvider;
  sessionId: string;
  channelId: string;
  threadId: string;
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
      const iconCustomEmojiId = await input.provider
        .resolveForumTopicIconCustomEmojiId(
          getTelegramTopicIconEmojiPreferences(title),
        )
        .catch(() => undefined);
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
}): T & { updateTitle: (title: string | null) => void } {
  let lastRequestedTitle: string | null | undefined;
  let titleUpdate = Promise.resolve();

  return {
    ...input.activity,
    updateTitle(title) {
      if (!title || title === lastRequestedTitle) return;
      lastRequestedTitle = title;
      titleUpdate = titleUpdate.then(() =>
        syncFastAgentTelegramTopicTitleBestEffort(input),
      );
    },
    async dispose() {
      await Promise.all([input.activity.dispose(), titleUpdate]);
    },
  } as T & { updateTitle: (title: string | null) => void };
}
