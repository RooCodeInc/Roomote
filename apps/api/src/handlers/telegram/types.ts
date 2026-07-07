import type { QueuedCommunicationMessage } from '@roomote/types';

export type QueuedTelegramCommunicationMessage = QueuedCommunicationMessage & {
  provider: 'telegram';
  userId: string;
};

export type TelegramConversationRef = {
  chatId: string;
  threadId?: string;
};

export type TelegramWorkspaceSelection = {
  environmentId?: string;
  repoForPayload: string;
  workspaceDisplayName: string;
};
