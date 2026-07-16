import {
  type CommunicationProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

interface SlackReplyContext {
  channel: string;
  threadTs?: string;
}

interface CommunicationReplyContext {
  provider: CommunicationProvider;
  channelId: string;
  threadId?: string;
}

const RESERVED_SLACK_MCP_ENV_KEYS = [
  'ROOMOTE_SLACK_CHANNEL',
  'ROOMOTE_SLACK_THREAD_TS',
  'ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE',
] as const;

const RESERVED_COMMUNICATION_MCP_ENV_KEYS = [
  'ROOMOTE_COMMUNICATION_PROVIDER',
  'ROOMOTE_COMMUNICATION_CHANNEL_ID',
  'ROOMOTE_COMMUNICATION_THREAD_ID',
] as const;

export function getSlackReplyContext(taskRun: {
  payload: unknown;
}): SlackReplyContext | null {
  const channel = getSlackChannelFromTaskPayload(taskRun.payload);
  const threadTs =
    getSlackThreadTsFromTaskPayload(taskRun.payload) ?? undefined;

  if (channel) {
    return { channel, ...(threadTs ? { threadTs } : {}) };
  }

  return null;
}

export function getCommunicationReplyContext(taskRun: {
  payload: unknown;
}): CommunicationReplyContext | null {
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  const channelId = getCommunicationChannelFromTaskPayload(taskRun.payload);
  const threadId = getCommunicationThreadIdFromTaskPayload(taskRun.payload);

  if (!provider || !channelId) {
    return null;
  }

  return {
    provider,
    channelId,
    ...(threadId ? { threadId } : {}),
  };
}

export function buildMcpTaskEnv(input: {
  runtimeEnv: Record<string, string>;
  unsanitizedEnv: Record<string, string | undefined>;
  slackReplyContext: SlackReplyContext | null;
  communicationReplyContext?: CommunicationReplyContext | null;
  /**
   * When true, channel-only Slack jobs may open a top-level root on first
   * closeout (automation execution late-bind). Satisfaction enforcement is only
   * safe when a thread already exists or late-bind is authorized; otherwise the
   * agent is forced to call send_chat_reply that the API will 403.
   */
  allowLateBoundSlackRoot?: boolean;
}): Record<string, string> {
  const mcpTaskEnv: Record<string, string> = { ...input.runtimeEnv };

  for (const key of RESERVED_SLACK_MCP_ENV_KEYS) {
    delete mcpTaskEnv[key];
  }
  for (const key of RESERVED_COMMUNICATION_MCP_ENV_KEYS) {
    delete mcpTaskEnv[key];
  }

  if (input.unsanitizedEnv.ROOMOTE_AUTH_BYPASS_VALUE) {
    mcpTaskEnv.ROOMOTE_AUTH_BYPASS_VALUE =
      input.unsanitizedEnv.ROOMOTE_AUTH_BYPASS_VALUE;
  }

  if (input.unsanitizedEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME) {
    mcpTaskEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME =
      input.unsanitizedEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
  }

  if (input.slackReplyContext) {
    mcpTaskEnv.ROOMOTE_SLACK_CHANNEL = input.slackReplyContext.channel;
    if (input.slackReplyContext.threadTs) {
      mcpTaskEnv.ROOMOTE_SLACK_THREAD_TS = input.slackReplyContext.threadTs;
    }
    // Channel alone is enough for post_to_slack_channel destination lookups
    // (for example CodeQL scan blockers). Reply-satisfaction only applies when
    // the job can actually answer with send_chat_reply: an existing thread, or a
    // late-bound automation work-item root.
    if (
      input.slackReplyContext.threadTs ||
      input.allowLateBoundSlackRoot === true
    ) {
      mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = [
        input.runtimeEnv.HOME ?? '/tmp',
        '.config',
        'opencode',
        'roomote-slack-reply-satisfaction.json',
      ].join('/');
    }
  }

  if (input.communicationReplyContext) {
    mcpTaskEnv.ROOMOTE_COMMUNICATION_PROVIDER =
      input.communicationReplyContext.provider;
    mcpTaskEnv.ROOMOTE_COMMUNICATION_CHANNEL_ID =
      input.communicationReplyContext.channelId;
    if (input.communicationReplyContext.threadId) {
      mcpTaskEnv.ROOMOTE_COMMUNICATION_THREAD_ID =
        input.communicationReplyContext.threadId;
    }
    if (
      input.communicationReplyContext.provider === 'telegram' ||
      input.communicationReplyContext.provider === 'teams' ||
      input.communicationReplyContext.provider === 'discord'
    ) {
      // Telegram, Teams, and Discord tasks use the same turn-satisfaction
      // machinery as Slack (ack/closeout enforcement and current-turn emoji
      // reactions).
      mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE ??= [
        input.runtimeEnv.HOME ?? '/tmp',
        '.config',
        'opencode',
        'roomote-slack-reply-satisfaction.json',
      ].join('/');
    }
  }

  return mcpTaskEnv;
}
