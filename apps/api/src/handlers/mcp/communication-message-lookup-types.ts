import type {
  CommunicationChannelMessagesRequest,
  CommunicationChannelMessagesResponse,
  CommunicationLookupMessage,
  SupportedCommunicationLookupProvider,
} from '@roomote/types';

export type {
  CommunicationChannelMessagesResponse as CommunicationChannelMessagesPayload,
  CommunicationLookupMessage,
  SupportedCommunicationLookupProvider,
} from '@roomote/types';

export type CommunicationLookupTaskRun = {
  actingUserId?: string | null;
  payload: unknown;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
};

export type ParsedCommunicationReference = {
  provider: SupportedCommunicationLookupProvider;
  channelId: string;
  messageId?: string;
  workspaceId?: string;
  workspaceDomain?: string;
};

export type CommunicationMessageContextPayload = {
  provider: SupportedCommunicationLookupProvider;
  slackTeamId?: string;
  channelId: string;
  requestedMessageId: string;
  threadId: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: CommunicationLookupMessage[];
};

export type CommunicationLookupStrategy = {
  provider: SupportedCommunicationLookupProvider;
  parseReference(
    raw: string,
  ): Omit<ParsedCommunicationReference, 'provider'> | null;
  getMessageContext(options: {
    channel?: string;
    messageId: string;
    workspaceId?: string;
    workspaceDomain?: string;
    taskRun?: CommunicationLookupTaskRun | null;
    actingUserId?: string | null;
  }): Promise<CommunicationMessageContextPayload>;
  getChannelMessages(
    options: CommunicationChannelMessagesRequest & {
      workspaceId?: string;
      workspaceDomain?: string;
      taskRun?: CommunicationLookupTaskRun | null;
      actingUserId?: string | null;
    },
  ): Promise<CommunicationChannelMessagesResponse>;
};
