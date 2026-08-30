import {
  type CommunicationProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getFastAgentParentFromPayload,
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

export function isFastAgentChildTaskRun(taskRun: {
  payload: unknown;
}): boolean {
  return getFastAgentParentFromPayload(taskRun.payload) !== null;
}

function hasInheritedCommunicationContext(payload: unknown): boolean {
  return (
    Boolean(payload) &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).communicationContextInherited === true
  );
}

export function getSlackReplyContext(taskRun: {
  payload: unknown;
}): SlackReplyContext | null {
  if (hasInheritedCommunicationContext(taskRun.payload)) {
    return null;
  }

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
  if (hasInheritedCommunicationContext(taskRun.payload)) {
    return null;
  }

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
    mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = [
      input.runtimeEnv.HOME ?? '/tmp',
      '.config',
      'opencode',
      'roomote-slack-reply-satisfaction.json',
    ].join('/');
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

  if (input.runtimeEnv.ROOMOTE_FAST_AGENT_CHILD === 'true') {
    // Fast children cannot post to the inherited chat surface directly, but
    // their private parent relay still uses the normal lifecycle hooks.
    mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE ??= [
      input.runtimeEnv.HOME ?? '/tmp',
      '.config',
      'opencode',
      'roomote-slack-reply-satisfaction.json',
    ].join('/');
  }

  return mcpTaskEnv;
}
