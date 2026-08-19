import {
  buildMcpTaskEnv,
  getCommunicationReplyContext,
  getSlackReplyContext,
  isFastAgentChildTaskRun,
} from '../mcp-task-env';

describe('getSlackReplyContext', () => {
  it('returns null when a snapshot resume task run has no Slack metadata', () => {
    expect(
      getSlackReplyContext({
        payload: {},
      }),
    ).toBeNull();
  });

  it('returns Slack context for any Slack-linked job with channel metadata', () => {
    expect(
      getSlackReplyContext({
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
        },
      }),
    ).toEqual({
      channel: 'C123',
      threadTs: '111.222',
    });
  });

  it('returns Slack channel context before a delayed thread exists', () => {
    expect(
      getSlackReplyContext({
        payload: {
          slackChannel: 'C123',
        },
      }),
    ).toEqual({
      channel: 'C123',
    });
  });

  it('does not activate inherited Slack source context', () => {
    expect(
      getSlackReplyContext({
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
          communicationContextInherited: true,
        },
      }),
    ).toBeNull();
  });
});

describe('getCommunicationReplyContext', () => {
  it('does not activate Fast child Slack context inherited from its parent', () => {
    const taskRun = {
      payload: {
        communicationProvider: 'slack',
        communicationChannelId: 'C123',
        communicationThreadId: '111.222',
        communicationContextInherited: true,
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'slack',
            workspaceId: 'T123',
            conversationId: '111.222',
            replyTarget: { channelId: 'C123', threadId: '111.222' },
          },
        },
      },
    };

    expect(getSlackReplyContext(taskRun)).toBeNull();
    expect(getCommunicationReplyContext(taskRun)).toBeNull();
    expect(isFastAgentChildTaskRun(taskRun)).toBe(true);
  });

  it('returns Teams communication context from provider-neutral payload metadata', () => {
    expect(
      getCommunicationReplyContext({
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: '19:conversation@thread.v2',
          communicationThreadId: 'activity-root',
        },
      }),
    ).toEqual({
      provider: 'teams',
      channelId: '19:conversation@thread.v2',
      threadId: 'activity-root',
    });
  });

  it('returns Telegram communication context from provider-neutral payload metadata', () => {
    expect(
      getCommunicationReplyContext({
        payload: {
          communicationProvider: 'telegram',
          communicationChannelId: '-100456',
          communicationThreadId: '7',
        },
      }),
    ).toEqual({
      provider: 'telegram',
      channelId: '-100456',
      threadId: '7',
    });
  });

  it('returns Discord communication context from provider-neutral payload metadata', () => {
    expect(
      getCommunicationReplyContext({
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
      }),
    ).toEqual({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
  });

  it('does not activate direct Discord replies for a Fast child task', () => {
    const taskRun = {
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'child-thread-1',
        communicationContextInherited: true,
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'discord',
            workspaceId: 'guild-1',
            conversationId: 'interaction-1',
            replyTarget: { channelId: 'channel-1' },
          },
        },
      },
    };

    expect(getCommunicationReplyContext(taskRun)).toBeNull();
    expect(isFastAgentChildTaskRun(taskRun)).toBe(true);
  });

  it('does not activate inherited provider-neutral source context', () => {
    expect(
      getCommunicationReplyContext({
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: '19:source-conversation@thread.v2',
          communicationThreadId: 'source-activity',
          communicationContextInherited: true,
        },
      }),
    ).toBeNull();
  });
});

describe('buildMcpTaskEnv', () => {
  it('removes leaked Slack reply env for non-Slack jobs', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        ROOMOTE_TASK_ID: 'task-1',
        ROOMOTE_SLACK_CHANNEL: 'CLEAKED',
        ROOMOTE_SLACK_THREAD_TS: '111.222',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: '/tmp/leaked.json',
      },
      unsanitizedEnv: {},
      slackReplyContext: null,
    });

    expect(result).toEqual({
      ROOMOTE_TASK_ID: 'task-1',
    });
  });

  it('replaces leaked Slack reply env with trusted Slack context', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        ROOMOTE_TASK_ID: 'task-1',
        ROOMOTE_SLACK_CHANNEL: 'CLEAKED',
        ROOMOTE_SLACK_THREAD_TS: '111.222',
      },
      unsanitizedEnv: {
        ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
        ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-bypass-roomote-auth',
      },
      slackReplyContext: {
        channel: 'CTRUSTED',
        threadTs: '999.000',
      },
    });

    expect(result).toEqual({
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
      ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-bypass-roomote-auth',
      ROOMOTE_SLACK_CHANNEL: 'CTRUSTED',
      ROOMOTE_SLACK_THREAD_TS: '999.000',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/tmp/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('registers trusted Slack channel env before a delayed thread exists', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        HOME: '/home/worker',
        ROOMOTE_TASK_ID: 'task-1',
        ROOMOTE_SLACK_THREAD_TS: '111.222',
      },
      unsanitizedEnv: {},
      slackReplyContext: {
        channel: 'CTRUSTED',
      },
    });

    expect(result).toEqual({
      HOME: '/home/worker',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_SLACK_CHANNEL: 'CTRUSTED',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/home/worker/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('always registers Slack reply satisfaction state for Slack-linked jobs', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        HOME: '/home/worker',
        ROOMOTE_TASK_ID: 'task-1',
      },
      unsanitizedEnv: {},
      slackReplyContext: {
        channel: 'CTRUSTED',
        threadTs: '999.000',
      },
    });

    expect(result).toEqual({
      HOME: '/home/worker',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_SLACK_CHANNEL: 'CTRUSTED',
      ROOMOTE_SLACK_THREAD_TS: '999.000',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/home/worker/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('registers Teams chat reply env with the turn-satisfaction state file', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        HOME: '/home/worker',
        ROOMOTE_TASK_ID: 'task-1',
        ROOMOTE_COMMUNICATION_PROVIDER: 'slack',
        ROOMOTE_COMMUNICATION_CHANNEL_ID: 'CLEAKED',
        ROOMOTE_COMMUNICATION_THREAD_ID: '111.222',
      },
      unsanitizedEnv: {},
      slackReplyContext: null,
      communicationReplyContext: {
        provider: 'teams',
        channelId: '19:conversation@thread.v2',
        threadId: 'activity-root',
      },
    });

    expect(result).toEqual({
      HOME: '/home/worker',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_COMMUNICATION_PROVIDER: 'teams',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: '19:conversation@thread.v2',
      ROOMOTE_COMMUNICATION_THREAD_ID: 'activity-root',
      // Deliberate reversal of the earlier "no enforcement for Teams" pin:
      // Teams turns get ack/closeout enforcement like Slack and Telegram.
      // Follow-up turns can also be satisfied by emoji-only Teams messages.
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/home/worker/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('registers Telegram chat reply env with the turn-satisfaction state file', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        HOME: '/home/worker',
        ROOMOTE_TASK_ID: 'task-1',
        ROOMOTE_COMMUNICATION_PROVIDER: 'slack',
        ROOMOTE_COMMUNICATION_CHANNEL_ID: 'CLEAKED',
        ROOMOTE_COMMUNICATION_THREAD_ID: '111.222',
      },
      unsanitizedEnv: {},
      slackReplyContext: null,
      communicationReplyContext: {
        provider: 'telegram',
        channelId: '-100456',
        threadId: '7',
      },
    });

    expect(result).toEqual({
      HOME: '/home/worker',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_COMMUNICATION_PROVIDER: 'telegram',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: '-100456',
      ROOMOTE_COMMUNICATION_THREAD_ID: '7',
      // Telegram uses the same ack/closeout and current-turn reaction
      // machinery as Slack.
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/home/worker/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('registers Discord chat reply env with the turn-satisfaction state file', () => {
    const result = buildMcpTaskEnv({
      runtimeEnv: {
        HOME: '/home/worker',
        ROOMOTE_TASK_ID: 'task-1',
      },
      unsanitizedEnv: {},
      slackReplyContext: null,
      communicationReplyContext: {
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
    });

    expect(result).toEqual({
      HOME: '/home/worker',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_COMMUNICATION_PROVIDER: 'discord',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: 'channel-1',
      ROOMOTE_COMMUNICATION_THREAD_ID: 'thread-1',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/home/worker/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });
});
