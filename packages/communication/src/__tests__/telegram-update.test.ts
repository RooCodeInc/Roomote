import { describe, expect, it } from 'vitest';

import {
  getNewTelegramMessageReactions,
  getTelegramNewTaskCommand,
  getTelegramUpdateCallbackQuery,
  getTelegramUpdateCommunicationMetadata,
  getTelegramUpdateMessageReaction,
  isNewTelegramThumbsUpReaction,
  isTelegramStartCommand,
  isTelegramTaskEntryUpdate,
  parseTelegramUpdate,
  telegramUpdateToQueuedCommunicationMessage,
} from '../telegram-update';

describe('Telegram update helpers', () => {
  it('recognizes /start commands in private chats only', () => {
    const buildUpdate = (text: string, chatType = 'private') => ({
      update_id: 1,
      message: {
        message_id: 2,
        chat: { id: 3, type: chatType },
        text,
      },
    });

    const parse = (update: unknown) => parseTelegramUpdate(update).data!;

    expect(isTelegramStartCommand(parse(buildUpdate('/start')))).toBe(true);
    expect(isTelegramStartCommand(parse(buildUpdate('/start@my_bot')))).toBe(
      true,
    );
    // `/start <text>` keeps its task-invocation meaning.
    expect(
      isTelegramStartCommand(parse(buildUpdate('/start please check this'))),
    ).toBe(false);
    expect(isTelegramStartCommand(parse(buildUpdate('/startle me')))).toBe(
      false,
    );
    expect(isTelegramStartCommand(parse(buildUpdate('fix the bug')))).toBe(
      false,
    );
    expect(isTelegramStartCommand(parse(buildUpdate('/start', 'group')))).toBe(
      false,
    );
  });

  it('parses callback_query updates', () => {
    const parsed = parseTelegramUpdate({
      update_id: 5,
      callback_query: {
        id: 'cb-1',
        from: { id: 111, first_name: 'Ada' },
        data: 'cancel_task:42',
        message: {
          message_id: 777,
          chat: { id: 222, type: 'private' },
        },
      },
    });

    expect(parsed.success).toBe(true);

    const callbackQuery = getTelegramUpdateCallbackQuery(parsed.data!);

    expect(callbackQuery?.id).toBe('cb-1');
    expect(callbackQuery?.data).toBe('cancel_task:42');
    expect(callbackQuery?.message?.message_id).toBe(777);
  });

  it('parses newly-added native thumbs-up reactions', () => {
    const parsed = parseTelegramUpdate({
      update_id: 6,
      message_reaction: {
        chat: { id: -100456, type: 'supergroup' },
        message_id: 778,
        message_thread_id: 7,
        date: 1_700_000_000,
        user: { id: 111, first_name: 'Ada' },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });

    expect(parsed.success).toBe(true);
    const reaction = getTelegramUpdateMessageReaction(parsed.data!);
    expect(reaction?.message_id).toBe(778);
    expect(reaction && isNewTelegramThumbsUpReaction(reaction)).toBe(true);
    expect(
      reaction &&
        isNewTelegramThumbsUpReaction({
          ...reaction,
          old_reaction: [{ type: 'emoji', emoji: '👍' }],
        }),
    ).toBe(false);
    expect(reaction && getNewTelegramMessageReactions(reaction)).toEqual([
      { name: '👍' },
    ]);
    expect(
      reaction &&
        getNewTelegramMessageReactions({
          ...reaction,
          old_reaction: [{ type: 'emoji', emoji: '👍' }],
          new_reaction: [
            { type: 'emoji', emoji: '👍' },
            { type: 'custom_emoji', custom_emoji_id: 'custom-1' },
          ],
        }),
    ).toEqual([{ name: 'custom_emoji:custom-1', id: 'custom-1' }]);
  });

  it('parses Telegram messages into queued communication messages', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1001,
      message: {
        message_id: 42,
        text: '@roomote_bot run the tests',
        from: {
          id: 123,
          is_bot: false,
          first_name: 'Ada',
          last_name: 'Lovelace',
          username: 'ada',
        },
        chat: {
          id: -100456,
          type: 'supergroup',
          title: 'Engineering',
        },
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      telegramUpdateToQueuedCommunicationMessage(parsed.data, {
        botUsername: 'roomote_bot',
        userId: 'user-1',
      }),
    ).toEqual({
      provider: 'telegram',
      text: 'run the tests',
      user: 'Ada Lovelace',
      userId: 'user-1',
      ts: '42',
      channel: '-100456',
    });
    expect(getTelegramUpdateCommunicationMetadata(parsed.data)).toEqual({
      communicationProvider: 'telegram',
      communicationChannelId: '-100456',
      communicationMessageId: '42',
    });
  });

  it('accepts native voice notes as task entry messages', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1008,
      message: {
        message_id: 49,
        chat: { id: 123, type: 'private' },
        voice: {
          file_id: 'voice-file',
          file_unique_id: 'voice-unique',
          duration: 4,
          mime_type: 'audio/ogg',
          file_size: 1234,
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(isTelegramTaskEntryUpdate(parsed.data!)).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(parsed.data!),
    ).toMatchObject({ text: 'Audio attachment: voice message' });
  });

  it('tracks Telegram forum topics as communication threads', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1002,
      message: {
        message_id: 43,
        message_thread_id: 7,
        text: 'continue here',
        chat: {
          id: -100456,
          type: 'supergroup',
          title: 'Engineering',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(telegramUpdateToQueuedCommunicationMessage(parsed.data)).toEqual({
      provider: 'telegram',
      text: 'continue here',
      user: 'Telegram user',
      ts: '43',
      channel: '-100456',
      threadTs: '7',
    });
    expect(getTelegramUpdateCommunicationMetadata(parsed.data)).toEqual({
      communicationProvider: 'telegram',
      communicationChannelId: '-100456',
      communicationThreadId: '7',
      communicationMessageId: '43',
    });
  });

  it('treats private messages as task entry updates', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1003,
      message: {
        message_id: 44,
        text: '/start explain this repo',
        chat: {
          id: 123,
          type: 'private',
          first_name: 'Ada',
        },
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(isTelegramTaskEntryUpdate(parsed.data)).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(parsed.data, {
        botUsername: 'roomote_bot',
      }),
    ).toMatchObject({
      text: 'explain this repo',
    });
  });

  it('requires a bot mention for group task entry updates', () => {
    const unmentioned = parseTelegramUpdate({
      update_id: 1004,
      message: {
        message_id: 45,
        text: 'run the tests',
        chat: {
          id: -100456,
          type: 'group',
          title: 'Engineering',
        },
      },
    });
    const mentioned = parseTelegramUpdate({
      update_id: 1005,
      message: {
        message_id: 46,
        text: '/roomote@roomote_bot run the tests',
        chat: {
          id: -100456,
          type: 'group',
          title: 'Engineering',
        },
        entities: [{ type: 'bot_command', offset: 0, length: 20 }],
      },
    });

    expect(unmentioned.success).toBe(true);
    expect(mentioned.success).toBe(true);
    if (!unmentioned.success || !mentioned.success) {
      return;
    }

    expect(
      isTelegramTaskEntryUpdate(unmentioned.data, {
        botUsername: 'roomote_bot',
      }),
    ).toBe(false);
    expect(
      isTelegramTaskEntryUpdate(mentioned.data, {
        botUsername: 'roomote_bot',
      }),
    ).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(mentioned.data, {
        botUsername: 'roomote_bot',
      }),
    ).toMatchObject({
      text: 'run the tests',
    });
  });

  it('accepts Telegram bot profile links as group mentions', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1006,
      message: {
        message_id: 47,
        text: '@roomote_bot what changed this week?',
        from: {
          id: 123,
          first_name: 'Ada',
          username: 'ada',
        },
        chat: {
          id: -100456,
          type: 'supergroup',
          title: 'Engineering',
          is_forum: true,
        },
        entities: [
          {
            type: 'text_link',
            offset: 0,
            length: 12,
            url: 'https://t.me/roomote_bot',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(
      isTelegramTaskEntryUpdate(parsed.data, {
        botUsername: 'roomote_bot',
      }),
    ).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(parsed.data, {
        botUsername: 'roomote_bot',
        userId: 'user-1',
      }),
    ).toMatchObject({
      text: 'what changed this week?',
      userId: 'user-1',
    });
  });

  it('does not treat a text link to another Telegram account as a bot mention', () => {
    const parsed = parseTelegramUpdate({
      update_id: 1007,
      message: {
        message_id: 48,
        text: '@roomote_bot run the tests',
        chat: {
          id: -100456,
          type: 'supergroup',
          title: 'Engineering',
          is_forum: true,
        },
        entities: [
          {
            type: 'text_link',
            offset: 0,
            length: 12,
            url: 'https://t.me/not_roomote',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    expect(
      isTelegramTaskEntryUpdate(parsed.data!, {
        botUsername: 'roomote_bot',
      }),
    ).toBe(false);
  });

  it('treats a bot command as an invocation only when it leads the message', () => {
    const buildUpdate = (
      text: string,
      chatType: string,
      entities: Array<{ type: string; offset: number; length: number }>,
    ) => {
      const parsed = parseTelegramUpdate({
        update_id: 3001,
        message: {
          message_id: 60,
          chat: {
            id: chatType === 'private' ? 5 : -100456,
            type: chatType,
            title: chatType === 'private' ? undefined : 'Engineering',
          },
          text,
          entities,
        },
      });

      return parsed.data!;
    };

    // A mid-sentence command in a private chat is message content: it is
    // neither stripped from the queued text nor treated specially.
    expect(
      telegramUpdateToQueuedCommunicationMessage(
        buildUpdate('ping me when you are /status with the build', 'private', [
          { type: 'bot_command', offset: 21, length: 7 },
        ]),
        { botUsername: 'roomote_bot' },
      ),
    ).toMatchObject({
      text: 'ping me when you are /status with the build',
    });

    expect(
      telegramUpdateToQueuedCommunicationMessage(
        buildUpdate('run /deploy on staging', 'private', [
          { type: 'bot_command', offset: 4, length: 7 },
        ]),
        { botUsername: 'roomote_bot' },
      ),
    ).toMatchObject({
      text: 'run /deploy on staging',
    });

    // A leading command is still an invocation and still stripped.
    expect(
      telegramUpdateToQueuedCommunicationMessage(
        buildUpdate('/deploy@roomote_bot run it', 'group', [
          { type: 'bot_command', offset: 0, length: 19 },
        ]),
        { botUsername: 'roomote_bot' },
      ),
    ).toMatchObject({
      text: 'run it',
    });

    // A mid-sentence bot-suffixed command no longer counts as group task
    // entry — commands must lead the message, matching /new's anchoring.
    expect(
      isTelegramTaskEntryUpdate(
        buildUpdate('run /deploy@roomote_bot now', 'group', [
          { type: 'bot_command', offset: 4, length: 19 },
        ]),
        { botUsername: 'roomote_bot' },
      ),
    ).toBe(false);

    // Mentions keep addressing the bot from anywhere in the text.
    const midTextMention = buildUpdate('hey @roomote_bot run it', 'group', [
      { type: 'mention', offset: 4, length: 12 },
    ]);

    expect(
      isTelegramTaskEntryUpdate(midTextMention, {
        botUsername: 'roomote_bot',
      }),
    ).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(midTextMention, {
        botUsername: 'roomote_bot',
      }),
    ).toMatchObject({
      text: 'hey run it',
    });

    // A leading command preceded only by this bot's mention still counts.
    expect(
      isTelegramTaskEntryUpdate(
        buildUpdate('@roomote_bot /deploy now', 'group', [
          { type: 'mention', offset: 0, length: 12 },
          { type: 'bot_command', offset: 13, length: 7 },
        ]),
        { botUsername: 'roomote_bot' },
      ),
    ).toBe(true);
  });

  it('treats an attachment-only private message as task input', () => {
    const parsed = parseTelegramUpdate({
      update_id: 4001,
      message: {
        message_id: 70,
        chat: { id: 5, type: 'private' },
        photo: [
          {
            file_id: 'photo-large',
            file_unique_id: 'photo-1',
            width: 1280,
            height: 720,
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    expect(isTelegramTaskEntryUpdate(parsed.data!)).toBe(true);
    expect(
      telegramUpdateToQueuedCommunicationMessage(parsed.data!),
    ).toMatchObject({ text: 'Image attachment' });
  });

  it('strips bot mentions from group media captions', () => {
    const buildCaptionUpdate = (caption: string) =>
      parseTelegramUpdate({
        update_id: 4002,
        message: {
          message_id: 71,
          chat: { id: -1007, type: 'group', title: 'Engineering' },
          caption,
          caption_entities: [{ type: 'mention', offset: 0, length: 12 }],
          photo: [
            {
              file_id: 'photo-large',
              file_unique_id: 'photo-1',
              width: 1280,
              height: 720,
            },
          ],
        },
      }).data!;

    expect(
      telegramUpdateToQueuedCommunicationMessage(
        buildCaptionUpdate('@roomote_bot what is this?'),
        { botUsername: 'roomote_bot' },
      ),
    ).toMatchObject({ text: 'what is this?' });
    expect(
      telegramUpdateToQueuedCommunicationMessage(
        buildCaptionUpdate('@roomote_bot'),
        { botUsername: 'roomote_bot' },
      ),
    ).toMatchObject({ text: 'Image attachment' });
  });

  describe('getTelegramNewTaskCommand', () => {
    const buildUpdate = (
      text: string,
      chatType: 'private' | 'group' = 'private',
      entities: Array<{ type: string; offset: number; length: number }> = [],
    ) => ({
      update_id: 2001,
      message: {
        message_id: 42,
        chat: {
          id: chatType === 'private' ? 5 : -1007,
          type: chatType,
          title: chatType === 'private' ? undefined : 'Engineering',
        },
        text,
        entities,
      },
    });

    const parse = (update: unknown) => parseTelegramUpdate(update).data!;

    it('detects /new in a private chat and strips the command', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/new fix the flaky auth test', 'private', [
              { type: 'bot_command', offset: 0, length: 4 },
            ]),
          ),
        ),
      ).toEqual({ command: 'new', text: 'fix the flaky auth test' });
    });

    it('does not recognize the removed /done alias', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/done run the tests', 'private', [
              { type: 'bot_command', offset: 0, length: 5 },
            ]),
          ),
        ),
      ).toBeNull();
    });

    it('is case-insensitive on the command name', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/NEW rebuild the index', 'private', [
              { type: 'bot_command', offset: 0, length: 4 },
            ]),
          ),
        ),
      ).toEqual({ command: 'new', text: 'rebuild the index' });
    });

    it('returns an empty text for a bare /new with no description', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/new', 'private', [
              { type: 'bot_command', offset: 0, length: 4 },
            ]),
          ),
        ),
      ).toEqual({ command: 'new', text: '' });
    });

    it('ignores /new mentioned mid-sentence', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('the /new endpoint returns 404, fix it', 'private', [
              { type: 'bot_command', offset: 4, length: 4 },
            ]),
          ),
        ),
      ).toBeNull();
    });

    it('requires the command to target this bot in groups', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/new fix the tests', 'group', [
              { type: 'bot_command', offset: 0, length: 4 },
            ]),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toBeNull();

      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/new@roomote_bot fix the tests', 'group', [
              { type: 'bot_command', offset: 0, length: 16 },
            ]),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toEqual({ command: 'new', text: 'fix the tests' });
    });

    it('accepts a leading bot mention as group targeting', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('@roomote_bot /new fix the tests', 'group', [
              { type: 'mention', offset: 0, length: 12 },
              { type: 'bot_command', offset: 13, length: 4 },
            ]),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toEqual({ command: 'new', text: 'fix the tests' });
    });

    it('does not leak a leading bot mention into the description', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate(
              '@roomote_bot /new@roomote_bot fix the tests',
              'group',
              [
                { type: 'mention', offset: 0, length: 12 },
                { type: 'bot_command', offset: 13, length: 16 },
              ],
            ),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toEqual({ command: 'new', text: 'fix the tests' });
    });

    it('ignores commands prefixed by someone else or suffixed for another bot', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('@someone_else /new fix the tests', 'group', [
              { type: 'mention', offset: 0, length: 13 },
              { type: 'bot_command', offset: 14, length: 4 },
            ]),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toBeNull();

      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/new@other_bot fix the tests', 'group', [
              { type: 'bot_command', offset: 0, length: 14 },
            ]),
          ),
          { botUsername: 'roomote_bot' },
        ),
      ).toBeNull();
    });

    it('returns null for unrelated commands and plain text', () => {
      expect(
        getTelegramNewTaskCommand(
          parse(
            buildUpdate('/start explain this', 'private', [
              { type: 'bot_command', offset: 0, length: 6 },
            ]),
          ),
        ),
      ).toBeNull();

      expect(
        getTelegramNewTaskCommand(
          parse(buildUpdate('just a regular message', 'private')),
        ),
      ).toBeNull();
    });
  });
});
