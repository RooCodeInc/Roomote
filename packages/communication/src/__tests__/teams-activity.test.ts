import { describe, expect, it } from 'vitest';

import {
  getTeamsActivityCommunicationMetadata,
  getTeamsActivityImageAttachments,
  getTeamsConversationMessageIdSuffix,
  isTeamsBotAuthoredActivity,
  isTeamsBotMentioned,
  isTeamsTaskEntryActivity,
  parseTeamsActivity,
  stripTeamsBotMentions,
  teamsActivityMentionsUserOtherThanBot,
  teamsActivityToQueuedCommunicationMessage,
} from '../teams-activity';

describe('Teams activity helpers', () => {
  it('parses Teams message activities into queued communication messages', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: '<at>Roomote</at> run the tests',
      from: {
        id: '29:user',
        name: 'Ada Lovelace',
      },
      conversation: {
        id: '19:conversation@thread.v2',
        tenantId: 'tenant-from-conversation',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        team: { id: 'team-1', name: 'Engineering' },
        channel: { id: '19:channel@thread.tacv2', name: 'Builds' },
      },
      replyToId: 'activity-root',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(teamsActivityToQueuedCommunicationMessage(parsed.data)).toEqual({
      provider: 'teams',
      text: 'run the tests',
      user: 'Ada Lovelace',
      ts: 'activity-2',
      channel: '19:conversation@thread.v2',
      threadTs: 'activity-root',
    });
    expect(getTeamsActivityCommunicationMetadata(parsed.data)).toEqual({
      communicationProvider: 'teams',
      communicationTeamId: 'team-1',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
      communicationChannelId: '19:conversation@thread.v2',
      communicationThreadId: 'activity-root',
      communicationMessageId: 'activity-2',
      teamsTenantId: 'tenant-1',
      teamsTeamId: 'team-1',
      teamsChannelId: '19:channel@thread.tacv2',
      teamsConversationId: '19:conversation@thread.v2',
      teamsThreadId: 'activity-root',
      teamsMessageId: 'activity-2',
      teamsServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });
  });

  it('uses the activity id as the thread id for top-level channel messages', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-root',
      text: 'start here',
      conversation: {
        id: '19:conversation@thread.v2',
        conversationType: 'channel',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      teamsActivityToQueuedCommunicationMessage(parsed.data),
    ).toMatchObject({
      ts: 'activity-root',
      threadTs: 'activity-root',
    });
  });

  it('prefers the conversation message suffix as the channel thread id', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-followup',
      text: 'keep going',
      conversation: {
        id: '19:conversation@thread.v2;messageid=activity-root',
        conversationType: 'channel',
      },
      replyToId: 'bot-reply-1',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      getTeamsConversationMessageIdSuffix(parsed.data.conversation.id),
    ).toBe('activity-root');
    expect(teamsActivityToQueuedCommunicationMessage(parsed.data)).toEqual({
      provider: 'teams',
      text: 'keep going',
      user: 'Teams user',
      ts: 'activity-followup',
      channel: '19:conversation@thread.v2;messageid=activity-root',
      threadTs: 'activity-root',
    });
    expect(getTeamsActivityCommunicationMetadata(parsed.data)).toMatchObject({
      communicationChannelId:
        '19:conversation@thread.v2;messageid=activity-root',
      communicationThreadId: 'activity-root',
      teamsThreadId: 'activity-root',
    });
  });

  it('does not use the activity id as the thread id for personal messages', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      text: 'continue here',
      conversation: {
        id: 'a:personal-conversation',
        conversationType: 'personal',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(teamsActivityToQueuedCommunicationMessage(parsed.data)).toEqual({
      provider: 'teams',
      text: 'continue here',
      user: 'Teams user',
      ts: 'activity-2',
      channel: 'a:personal-conversation',
    });
    expect(getTeamsActivityCommunicationMetadata(parsed.data)).toEqual({
      communicationProvider: 'teams',
      communicationChannelId: 'a:personal-conversation',
      communicationMessageId: 'activity-2',
      teamsConversationId: 'a:personal-conversation',
      teamsMessageId: 'activity-2',
    });
  });

  it('ignores non-message activities and empty message bodies', () => {
    const parsed = parseTeamsActivity({
      type: 'conversationUpdate',
      conversation: {
        id: '19:conversation@thread.v2',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(teamsActivityToQueuedCommunicationMessage(parsed.data)).toBeNull();
  });

  it('strips Teams mention markup from message text', () => {
    expect(
      stripTeamsBotMentions('<at id="0">Roomote</at>&nbsp;please continue'),
    ).toBe('please continue');
  });

  it('strips only the bot mention and keeps other Teams mentions readable', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      text: '<at>Roomote</at>&nbsp;ask <at>Matt Rubens</at> about this',
      recipient: {
        id: '28:bot',
        name: 'Roomote',
      },
      conversation: {
        id: '19:conversation@thread.v2',
        conversationType: 'channel',
      },
      entities: [
        {
          type: 'mention',
          text: '<at>Roomote</at>',
          mentioned: {
            id: '28:bot',
            name: 'Roomote',
          },
        },
        {
          type: 'mention',
          text: '<at>Matt Rubens</at>',
          mentioned: {
            id: '29:user',
            name: 'Matt Rubens',
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      teamsActivityToQueuedCommunicationMessage(parsed.data),
    ).toMatchObject({
      text: 'ask @Matt Rubens about this',
    });
  });

  it('keeps Teams image-only activities after stripping the bot mention', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-image-only',
      text: '<at>Roomote</at>',
      recipient: {
        id: '28:bot',
        name: 'Roomote',
      },
      conversation: {
        id: '19:conversation@thread.v2',
        conversationType: 'channel',
      },
      entities: [
        {
          type: 'mention',
          text: '<at>Roomote</at>',
          mentioned: {
            id: '28:bot',
            name: 'Roomote',
          },
        },
      ],
      attachments: [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(teamsActivityToQueuedCommunicationMessage(parsed.data)).toEqual({
      provider: 'teams',
      text: 'Image attachment',
      user: 'Teams user',
      ts: 'activity-image-only',
      channel: '19:conversation@thread.v2',
      threadTs: 'activity-image-only',
    });
  });

  it('detects bot mentions from Teams mention entities', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      text: '<at>Roomote</at> run the tests',
      recipient: {
        id: '28:bot',
        name: 'Roomote',
      },
      conversation: {
        id: '19:conversation@thread.v2',
        conversationType: 'channel',
      },
      entities: [
        {
          type: 'mention',
          text: '<at>Roomote</at>',
          mentioned: {
            id: '28:bot',
            name: 'Roomote',
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(isTeamsBotMentioned(parsed.data)).toBe(true);
    expect(isTeamsTaskEntryActivity(parsed.data)).toBe(true);
  });

  it('detects mentions of users other than the bot', () => {
    const baseActivity = {
      type: 'message',
      id: 'activity-2',
      recipient: {
        id: '28:bot',
        name: 'Roomote',
      },
      conversation: {
        id: '19:conversation@thread.v2',
        conversationType: 'channel',
      },
    };
    const botOnlyMention = parseTeamsActivity({
      ...baseActivity,
      text: '<at>Roomote</at> run the tests',
      entities: [
        {
          type: 'mention',
          text: '<at>Roomote</at>',
          mentioned: { id: '28:bot', name: 'Roomote' },
        },
      ],
    });
    const otherUserMention = parseTeamsActivity({
      ...baseActivity,
      text: '<at>Grace</at> what do you think?',
      entities: [
        {
          type: 'mention',
          text: '<at>Grace</at>',
          mentioned: { id: '29:user-3', name: 'Grace' },
        },
      ],
    });
    const noMentions = parseTeamsActivity({
      ...baseActivity,
      text: 'sounds good',
    });

    expect(botOnlyMention.success).toBe(true);
    expect(otherUserMention.success).toBe(true);
    expect(noMentions.success).toBe(true);
    if (
      !botOnlyMention.success ||
      !otherUserMention.success ||
      !noMentions.success
    ) {
      return;
    }

    expect(teamsActivityMentionsUserOtherThanBot(botOnlyMention.data)).toBe(
      false,
    );
    expect(teamsActivityMentionsUserOtherThanBot(otherUserMention.data)).toBe(
      true,
    );
    expect(teamsActivityMentionsUserOtherThanBot(noMentions.data)).toBe(false);
  });

  it('treats personal Teams messages as task entry activities', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      text: 'run the tests',
      conversation: {
        id: 'a:personal-conversation',
        conversationType: 'personal',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(isTeamsTaskEntryActivity(parsed.data)).toBe(true);
  });

  it('detects bot-authored Teams activities', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'bot-activity-1',
      text: 'Started a task',
      from: {
        id: '28:bot-app-id',
        name: 'Roomote',
      },
      recipient: {
        id: '29:user',
        name: 'Ada Lovelace',
      },
      conversation: {
        id: '19:conversation@thread.v2;messageid=activity-root',
        conversationType: 'channel',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      isTeamsBotAuthoredActivity(parsed.data, { botAppId: 'bot-app-id' }),
    ).toBe(true);
  });

  it('extracts prompt-safe Teams image attachment download URLs', () => {
    const parsed = parseTeamsActivity({
      type: 'message',
      id: 'activity-2',
      text: 'inspect these screenshots',
      conversation: {
        id: 'a:personal-conversation',
        conversationType: 'personal',
      },
      attachments: [
        {
          contentType: 'image/png',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
          name: 'direct.png',
        },
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-2/views/original',
        },
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          content: {
            downloadUrl: 'https://files.example.test/screenshot.jpg',
          },
          name: 'screenshot.jpg',
        },
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          content: {
            downloadUrl: 'https://files.example.test/opaque-download',
            fileType: 'png',
          },
        },
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: 'https://cards.example.test/card.json',
          name: 'card.json',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(getTeamsActivityImageAttachments(parsed.data)).toEqual([
      {
        contentType: 'image/png',
        contentUrl:
          'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
        name: 'direct.png',
      },
      {
        contentType: 'image/*',
        contentUrl:
          'https://smba.trafficmanager.net/amer/v3/attachments/att-2/views/original',
      },
      {
        contentType: 'image/jpeg',
        contentUrl: 'https://files.example.test/screenshot.jpg',
        name: 'screenshot.jpg',
      },
      {
        contentType: 'image/png',
        contentUrl: 'https://files.example.test/opaque-download',
      },
    ]);
  });
});
