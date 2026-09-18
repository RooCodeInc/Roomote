import {
  buildSlackAccountLinkConnectMessage,
  postSlackAccountLinkThreadReply,
} from '../account-link';
import type { SlackNotifier } from '../slack-notifier';

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
