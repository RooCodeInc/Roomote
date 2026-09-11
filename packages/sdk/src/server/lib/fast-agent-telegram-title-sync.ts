import type {
  FastAgentConversationRecord,
  FastAgentTurnActivity,
} from '@roomote/cloud-agents/server';
import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';

type TelegramTopicTitleProvider = Pick<
  TelegramCommunicationProvider,
  'editForumTopic'
>;

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
      await input.provider.editForumTopic({
        channelId: input.channelId,
        threadId: input.threadId,
        name: title,
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

export function addFastAgentTelegramTopicTitleSync(input: {
  activity: FastAgentTurnActivity & { reassert: () => void };
  provider: TelegramTopicTitleProvider;
  sessionId: string;
  channelId: string;
  threadId: string;
  resolveSession: () => Promise<FastAgentConversationRecord | null>;
}): FastAgentTurnActivity & { reassert: () => void } {
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
  };
}
