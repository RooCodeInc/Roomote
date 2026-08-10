import type {
  CommunicationProvider,
  QueuedCommunicationMessage,
} from '@roomote/types';

export type CommunicationMessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Signed CDN URL when the provider can still materialize the file. */
  url?: string;
};

export type CommunicationMessage = {
  provider: CommunicationProvider;
  id: string;
  user: string;
  username?: string;
  botId?: string;
  text: string;
  channelId: string;
  threadId?: string;
  fileCount: number;
  files?: CommunicationMessageAttachment[];
};

export type CommunicationMessageButton = {
  text: string;
  /** Provider-specific action payload (Telegram: callback_data, max 64 bytes). */
  callbackData?: string;
  /** Link button; mutually exclusive with callbackData. */
  url?: string;
};

export type CommunicationPostMessageInput = {
  channelId: string;
  threadId?: string;
  text?: string;
  blocks?: unknown[];
  images?: Array<{ url: string; altText: string; contentType?: string }>;
  serviceUrl?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  replyToMessageId?: string;
  tenantId?: string;
  teamId?: string;
  channelData?: Record<string, unknown>;
  attachments?: unknown[];
  /** Rows of action buttons; honored by providers with button support. */
  buttons?: CommunicationMessageButton[][];
};

export type CommunicationPostMessageResult = {
  provider: CommunicationProvider;
  channelId: string;
  messageId: string;
  /** The final text-bearing message when a provider splits one post. */
  lastTextMessageId?: string;
  threadId?: string;
};

export type CommunicationUpdateMessageInput = {
  channelId: string;
  messageId: string;
  text: string;
  serviceUrl?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  buttons?: CommunicationMessageButton[][];
};

export type CommunicationThreadLookupResult = {
  provider: CommunicationProvider;
  channelId: string;
  requestedMessageId: string;
  threadId: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: CommunicationMessage[];
};

export type CommunicationChannelMessagesResult = {
  provider: CommunicationProvider;
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount: number;
  messages: CommunicationMessage[];
};

export type CommunicationReactionResult = {
  provider: CommunicationProvider;
  channelId: string;
  messageId: string;
  name: string;
};

export type CommunicationOperation =
  | 'postMessage'
  | 'updateMessage'
  | 'fetchThreadMessages'
  | 'fetchChannelMessages'
  | 'addReaction';

export class UnsupportedCommunicationOperationError extends Error {
  readonly code = 'communication_operation_unsupported' as const;
  readonly provider: CommunicationProvider;
  readonly operation: CommunicationOperation;
  readonly help?: string;

  constructor(input: {
    provider: CommunicationProvider;
    operation: CommunicationOperation;
    message: string;
    help?: string;
  }) {
    super(input.message);
    this.name = 'UnsupportedCommunicationOperationError';
    this.provider = input.provider;
    this.operation = input.operation;
    this.help = input.help;
  }
}

export interface CommunicationProviderAdapter {
  readonly provider: CommunicationProvider;
  postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult>;
  updateMessage?(input: CommunicationUpdateMessageInput): Promise<void>;
  fetchThreadMessages?(input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationThreadLookupResult>;
  fetchChannelMessages?(input: {
    channelId: string;
    oldest?: string;
    latest?: string;
  }): Promise<CommunicationChannelMessagesResult>;
  addReaction?(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult>;
  removeReaction?(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult>;
}

export interface CommunicationInboundProvider {
  readonly provider: CommunicationProvider;
  queueMessage(input: {
    runId: number;
    message: QueuedCommunicationMessage;
  }): Promise<void>;
}
