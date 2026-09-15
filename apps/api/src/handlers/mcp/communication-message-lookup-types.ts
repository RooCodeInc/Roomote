import type { CommunicationProvider } from '@roomote/types';

export type SupportedCommunicationLookupProvider = Extract<
  CommunicationProvider,
  'slack' | 'discord'
>;

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

export type CommunicationLookupMessage = {
  provider: SupportedCommunicationLookupProvider;
  id: string;
  user: string;
  username?: string;
  botId?: string;
  text: string;
  channelId: string;
  threadId?: string;
  fileCount: number;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
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

export type CommunicationChannelMessagesPayload = {
  provider: SupportedCommunicationLookupProvider;
  slackTeamId?: string;
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
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
  getChannelMessages(options: {
    channel?: string;
    workspaceId?: string;
    workspaceDomain?: string;
    oldest?: string;
    latest?: string;
    taskRun?: CommunicationLookupTaskRun | null;
    actingUserId?: string | null;
  }): Promise<CommunicationChannelMessagesPayload>;
};
