import {
  buildSlackAccountLinkConnectMessage,
  buildRoutingConfirmBlocks,
  buildStartedBlocks,
  buildTaskFailedBlocks,
  postSlackAccountLinkThreadReply,
} from '../block-kit';
import type { SlackNotifier } from '../slack-notifier';

function getPrimarySectionText(
  blocks: ReturnType<typeof buildRoutingConfirmBlocks>,
): string {
  const block = blocks.find((candidate) => candidate.type === 'section');

  if (!block || block.type !== 'section' || !('text' in block) || !block.text) {
    throw new Error('Expected a leading section block with text');
  }

  return block.text.text;
}

function getActionsElements(
  blocks: ReturnType<typeof buildRoutingConfirmBlocks>,
): Record<string, unknown>[] {
  const block = blocks.find((candidate) => candidate.type === 'actions');

  if (!block || block.type !== 'actions' || !('elements' in block)) {
    throw new Error('Expected actions block');
  }

  return block.elements!;
}

function getFirstContextText(
  blocks: ReturnType<typeof buildRoutingConfirmBlocks>,
): string {
  const block = blocks.find((candidate) => candidate.type === 'context');

  if (!block || block.type !== 'context' || !('elements' in block)) {
    throw new Error('Expected context block');
  }

  const [element] = block.elements ?? [];
  if (!element || typeof element.text !== 'string') {
    throw new Error('Expected context block with text');
  }

  return element.text;
}

function getContextTexts(
  blocks: ReturnType<typeof buildRoutingConfirmBlocks>,
): string[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'context' || !('elements' in block)) {
      return [];
    }

    return (block.elements ?? []).flatMap((element) =>
      typeof element.text === 'string' ? [element.text] : [],
    );
  });
}

describe('Slack routing blocks', () => {
  it('keeps the routing confirmation copy neutral about environments', () => {
    const blocks = buildRoutingConfirmBlocks('App', undefined, {
      threadId: 'thread-1',
      confirmNonce: 'nonce-1',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      "I'll get started in `App`, OK?",
    );
  });

  it('keeps the same routing confirmation copy across repeated calls', () => {
    const blocks = buildRoutingConfirmBlocks('App', undefined, {
      threadId: 'thread-1',
      confirmNonce: 'nonce-1',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      "I'll get started in `App`, OK?",
    );
  });

  it('mentions the selected model in routing confirmations when present', () => {
    const blocks = buildRoutingConfirmBlocks('App', 'GLM 5.2', {
      threadId: 'thread-1',
      confirmNonce: 'nonce-1',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      "I'll get started in `App` using `GLM 5.2`, OK?",
    );
  });

  it('embeds both thread id and nonce in routing confirmation buttons', () => {
    const blocks = buildRoutingConfirmBlocks('App', undefined, {
      threadId: 'thread-1',
      confirmNonce: 'nonce-1',
    });

    const actionElements = getActionsElements(blocks);
    expect(actionElements).toEqual([
      expect.objectContaining({
        value: JSON.stringify({
          threadId: 'thread-1',
          confirmNonce: 'nonce-1',
        }),
      }),
      expect.objectContaining({
        value: JSON.stringify({
          threadId: 'thread-1',
          confirmNonce: 'nonce-1',
        }),
      }),
    ]);
  });

  it('keeps the started message copy neutral about environments', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Getting started on your task in App',
    );
  });

  it('keeps the same started message copy when a task URL is present', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
      taskUrl: 'https://example.com/task',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Getting started on your task in App',
    );
  });

  it('mentions the selected model in started messages when present', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      modelDisplayName: 'Opus 4.8',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Getting started on your task in App using Opus 4.8 as the coding model',
    );
  });

  it('uses a router kickoff phrase in started messages when present', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      kickoffMessage:
        'Looking into daily environment snapshots for faster startup in App',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Looking into daily environment snapshots for faster startup in App',
    );
  });

  it('keeps model override information with a router kickoff phrase', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      kickoffMessage: 'Checking login redirects in App with Opus 4.8',
      modelDisplayName: 'Opus 4.8',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Checking login redirects in App with Opus 4.8',
    );
  });

  it('falls back to the static template when kickoff text is empty', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      kickoffMessage: '   ',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Getting started on your task in App',
    );
  });

  it('appends the other-running-task count when provided', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
      otherRunningTasksCount: 2,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
    });

    expect(getPrimarySectionText(blocks)).toBe(
      'Getting started on your task in App',
    );
    expect(getFirstContextText(blocks)).toBe(
      '_2 other tasks currently running_',
    );
  });

  it('omits environment diagnostics unless explicitly enabled', () => {
    const originalDebugValue = process.env.ROOMOTE_DEBUG_KICKOFF_ENV;
    process.env.ROOMOTE_DEBUG_KICKOFF_ENV = 'false';

    try {
      const blocks = buildStartedBlocks({ workspaceDisplayName: 'App' });

      expect(
        getContextTexts(blocks).some((text) =>
          text.startsWith('_Environment: '),
        ),
      ).toBe(false);
    } finally {
      if (originalDebugValue === undefined) {
        delete process.env.ROOMOTE_DEBUG_KICKOFF_ENV;
      } else {
        process.env.ROOMOTE_DEBUG_KICKOFF_ENV = originalDebugValue;
      }
    }
  });

  it('includes safe environment diagnostics when explicitly enabled', () => {
    const originalDebugValue = process.env.ROOMOTE_DEBUG_KICKOFF_ENV;
    const originalAppEnv = process.env.R_APP_ENV;
    const originalPort = process.env.PORT;
    const originalSecret = process.env.TEST_KICKOFF_SECRET;
    process.env.ROOMOTE_DEBUG_KICKOFF_ENV = 'true';
    process.env.R_APP_ENV = 'test';
    process.env.PORT = '3000';
    process.env.TEST_KICKOFF_SECRET = 'should-not-appear';

    try {
      const blocks = buildStartedBlocks({ workspaceDisplayName: 'App' });

      const environmentText = getContextTexts(blocks).find((text) =>
        text.startsWith('_Environment: '),
      );
      expect(environmentText).toContain('R_APP_ENV=test');
      expect(environmentText).toContain('PORT=3000');
      expect(environmentText).not.toContain('DATABASE_URL=');
      expect(environmentText).not.toContain('should-not-appear');
    } finally {
      if (originalDebugValue === undefined) {
        delete process.env.ROOMOTE_DEBUG_KICKOFF_ENV;
      } else {
        process.env.ROOMOTE_DEBUG_KICKOFF_ENV = originalDebugValue;
      }

      if (originalAppEnv === undefined) {
        delete process.env.R_APP_ENV;
      } else {
        process.env.R_APP_ENV = originalAppEnv;
      }

      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }

      if (originalSecret === undefined) {
        delete process.env.TEST_KICKOFF_SECRET;
      } else {
        process.env.TEST_KICKOFF_SECRET = originalSecret;
      }
    }
  });

  it('embeds the task id and initiating Slack user id in cancel buttons', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
      taskId: 'task-123',
      initiatingSlackUserId: 'U123',
      taskUrl: 'https://example.com/task',
    });

    const actionElements = getActionsElements(blocks);

    expect(actionElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_id: 'cancel_task',
          value: JSON.stringify({
            taskId: 'task-123',
            slackUserId: 'U123',
          }),
        }),
      ]),
    );
  });

  it('omits slackUserId from cancel buttons when no initiating Slack user is provided', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
      taskId: 'task-123',
    });
    const actionElements = getActionsElements(blocks);

    expect(actionElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_id: 'cancel_task',
          value: JSON.stringify({
            taskId: 'task-123',
          }),
        }),
      ]),
    );
  });

  it('falls back to task run id in cancel buttons when task id is unavailable', () => {
    const blocks = buildStartedBlocks({
      workspaceDisplayName: 'App',
      runId: 123,
    });
    const actionElements = getActionsElements(blocks);

    expect(actionElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_id: 'cancel_task',
          value: JSON.stringify({
            runId: 123,
          }),
        }),
      ]),
    );
  });

  it('builds a retryable failed-task message', () => {
    const blocks = buildTaskFailedBlocks({
      runId: 123,
    });
    const actionElements = getActionsElements(blocks);

    expect(getPrimarySectionText(blocks)).toBe(
      "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
    );
    expect(actionElements).toEqual([
      expect.objectContaining({
        action_id: 'retry_failed_task',
        value: JSON.stringify({
          runId: 123,
        }),
      }),
    ]);
  });

  it('builds a retryable failed-task message with runtime-failure copy', () => {
    const blocks = buildTaskFailedBlocks({
      runId: 123,
      messageText:
        "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.",
    });
    const actionElements = getActionsElements(blocks);

    expect(getPrimarySectionText(blocks)).toBe(
      "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.",
    );
    expect(actionElements).toEqual([
      expect.objectContaining({
        action_id: 'retry_failed_task',
        value: JSON.stringify({
          runId: 123,
        }),
      }),
    ]);
  });
});

describe('postSlackAccountLinkThreadReply', () => {
  it('posts a public thread reply after sending the account-link DM', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('999.000');
    const slack = {
      postMessage: postMessageMock,
    } as unknown as SlackNotifier;

    await postSlackAccountLinkThreadReply({
      slack,
      channel: 'C123',
      threadTs: '111.000',
      slackUserId: 'U123',
      dmPromptSent: true,
      channelType: 'channel',
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      text: '<@U123> I sent you a DM to link your account.',
      channel: 'C123',
      thread_ts: '111.000',
    });
  });

  it('falls back to a public thread reply when the account-link DM fails', async () => {
    const postMessageMock = vi.fn().mockResolvedValueOnce('999.000');
    const slack = {
      postMessage: postMessageMock,
    } as unknown as SlackNotifier;

    await postSlackAccountLinkThreadReply({
      slack,
      channel: 'C123',
      threadTs: '111.000',
      slackUserId: 'U123',
      dmPromptSent: false,
      channelType: 'channel',
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      text: '<@U123> I need to link your account before I can help. Please open a DM with me and use the Link accounts button.',
      channel: 'C123',
      thread_ts: '111.000',
    });
  });

  it('skips the public thread reply when the user is already in a DM with Roomote', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('999.000');
    const slack = {
      postMessage: postMessageMock,
    } as unknown as SlackNotifier;

    await postSlackAccountLinkThreadReply({
      slack,
      channel: 'D123',
      threadTs: '111.000',
      slackUserId: 'U123',
      dmPromptSent: true,
      channelType: 'im',
    });

    expect(postMessageMock).not.toHaveBeenCalled();
  });
});

describe('buildSlackAccountLinkConnectMessage', () => {
  it('uses the current Slack onboarding positioning in the account-link DM', () => {
    const message = buildSlackAccountLinkConnectMessage('auth-token');

    expect(message).toMatchObject({
      text: '👋 Hi! Let me help you get started with Roomote.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "Hi, I'm Roomote.\nI handle the operational engineering work that shows up in Slack: bug reports, escalations, regressions, repo questions, and small fixes.",
          },
        },
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*To get started, I need to link your Slack and Roomote accounts.*\n\nThis links your identity so I can:\n• Associate tasks with you\n• Access your configured agents\n• Work with your authorized repositories',
          },
        },
        {
          type: 'actions',
          elements: [
            expect.objectContaining({
              type: 'button',
              action_id: 'connect_account',
              text: {
                type: 'plain_text',
                text: 'Link accounts',
                emoji: true,
              },
              style: 'primary',
            }),
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: "This is a one-time deal. We'll be chatting in no time.",
            },
          ],
        },
      ],
    });

    const actionsBlock = message.blocks?.find(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'actions',
    );

    expect(actionsBlock).toMatchObject({
      type: 'actions',
      elements: [
        expect.objectContaining({
          url: expect.stringContaining('state=auth-token'),
        }),
      ],
    });
  });
});
