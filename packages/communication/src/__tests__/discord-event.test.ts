import { describe, expect, it } from 'vitest';

import {
  discordEventToQueuedCommunicationMessage,
  formatDiscordAttachmentSummary,
  getDiscordEventCommunicationMetadata,
  getDiscordInteractionCommand,
  isDiscordImageAttachment,
  isDiscordTaskEntryEvent,
  parseDiscordGatewayEvent,
} from '../discord-event';

const botUserId = '100000000000000001';

function parse(input: unknown) {
  const dispatch = input as {
    t: 'MESSAGE_CREATE' | 'INTERACTION_CREATE';
    d: { id: string };
  };
  const result = parseDiscordGatewayEvent({
    eventId: dispatch.d.id,
    eventType: dispatch.t,
    payload: dispatch.d,
    receivedAt: '2026-07-12T12:00:00.000Z',
  });
  expect(result.success).toBe(true);
  if (!result.success) throw result.error;
  return result.data;
}

function messageEvent(input: {
  content?: string;
  guildId?: string;
  channel?: { id: string; type: number; parent_id?: string };
  attachments?: unknown[];
  mentions?: unknown[];
}) {
  return parse({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 1,
    d: {
      id: 'message-1',
      channel_id: input.channel?.id ?? 'channel-1',
      ...(input.guildId ? { guild_id: input.guildId } : {}),
      content: input.content ?? '',
      author: {
        id: 'user-1',
        username: 'matt',
        global_name: 'Matt',
      },
      mentions: input.mentions ?? [],
      attachments: input.attachments ?? [],
      ...(input.channel ? { channel: input.channel } : {}),
    },
  });
}

describe('Discord Gateway event normalization', () => {
  it('removes the bot mention without flattening a multiline request', () => {
    const event = messageEvent({
      content: '<@bot-1> Fix the tests\n\nThen run:\n```sh\npnpm test\n```',
      mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
    });

    expect(
      discordEventToQueuedCommunicationMessage(event, {
        botUserId: 'bot-1',
      })?.text,
    ).toBe('Fix the tests\n\nThen run:\n```sh\npnpm test\n```');
  });

  it('accepts DMs and removes no message context', () => {
    const event = messageEvent({ content: 'Please fix login' });

    expect(isDiscordTaskEntryEvent(event, { botUserId })).toBe(true);
    expect(
      discordEventToQueuedCommunicationMessage(event, { botUserId }),
    ).toEqual({
      provider: 'discord',
      text: 'Please fix login',
      user: 'Matt',
      ts: 'message-1',
      channel: 'channel-1',
      turnPolicy: { reactionsAllowed: true },
    });
  });

  it('requires a bot mention in guild channels outside task threads', () => {
    const ignored = messageEvent({
      content: 'Just chatting',
      guildId: 'guild-1',
    });
    const mentioned = messageEvent({
      content: `<@${botUserId}> please fix login`,
      guildId: 'guild-1',
      mentions: [{ id: botUserId, username: 'RoomoteBot', bot: true }],
    });

    expect(isDiscordTaskEntryEvent(ignored, { botUserId })).toBe(false);
    expect(
      discordEventToQueuedCommunicationMessage(mentioned, { botUserId }),
    ).toMatchObject({ text: 'please fix login' });
  });

  it('maps task-thread messages back to the parent channel and thread id', () => {
    const event = messageEvent({
      content: 'Here is a follow-up',
      guildId: 'guild-1',
      channel: {
        id: 'thread-1',
        type: 11,
        parent_id: 'channel-1',
      },
    });

    expect(getDiscordEventCommunicationMetadata(event)).toEqual({
      communicationProvider: 'discord',
      communicationChannelId: 'channel-1',
      communicationThreadId: 'thread-1',
      communicationMessageId: 'message-1',
      communicationGuildId: 'guild-1',
    });
    expect(
      discordEventToQueuedCommunicationMessage(event, { isTaskThread: true }),
    ).toMatchObject({
      channel: 'channel-1',
      threadTs: 'thread-1',
      text: 'Here is a follow-up',
    });
  });

  it('keeps signed attachment URLs out of prompts and accepts attachment-only input', () => {
    const attachment = {
      id: 'attachment-1',
      filename: 'screen.png',
      content_type: 'image/png',
      size: 1234,
      url: 'https://cdn.discordapp.com/attachments/signed-secret',
      proxy_url: 'https://media.discordapp.net/attachments/signed-secret',
      width: 800,
      height: 600,
    };
    const event = messageEvent({ attachments: [attachment] });

    expect(isDiscordImageAttachment(attachment)).toBe(true);
    expect(formatDiscordAttachmentSummary([attachment])).toBe(
      'Image: screen.png',
    );
    expect(
      discordEventToQueuedCommunicationMessage(event, {
        attachmentImages: ['data:image/png;base64,c2FmZQ=='],
      }),
    ).toMatchObject({
      text: 'Image: screen.png',
      images: ['data:image/png;base64,c2FmZQ=='],
    });
    expect(
      JSON.stringify(discordEventToQueuedCommunicationMessage(event)),
    ).not.toContain('signed-secret');
  });

  it('normalizes /new slash interactions', () => {
    const event = parse({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 2,
      d: {
        id: 'interaction-1',
        application_id: 'application-1',
        type: 2,
        token: 'interaction-token',
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        member: {
          nick: 'Matt R',
          user: { id: 'user-1', username: 'matt' },
        },
        data: {
          name: 'new',
          type: 1,
          options: [
            { name: 'request', type: 3, value: 'Build Discord support' },
          ],
        },
      },
    });

    expect(getDiscordInteractionCommand(event)).toEqual({
      name: 'new',
      request: 'Build Discord support',
    });
    expect(discordEventToQueuedCommunicationMessage(event)).toEqual({
      provider: 'discord',
      text: 'Build Discord support',
      user: 'Matt R',
      ts: 'interaction-1',
      channel: 'channel-1',
      turnPolicy: { reactionsAllowed: true },
    });
  });

  it('does not queue bot-authored messages or non-task commands', () => {
    const botEvent = parse({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'message-bot',
        channel_id: 'dm-1',
        content: 'hello',
        author: { id: botUserId, username: 'RoomoteBot', bot: true },
      },
    });
    const help = parse({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-help',
        application_id: 'application-1',
        type: 2,
        token: 'token',
        channel_id: 'channel-1',
        user: { id: 'user-1', username: 'matt' },
        data: { name: 'help' },
      },
    });

    expect(discordEventToQueuedCommunicationMessage(botEvent)).toBeNull();
    expect(discordEventToQueuedCommunicationMessage(help)).toBeNull();
  });
});
