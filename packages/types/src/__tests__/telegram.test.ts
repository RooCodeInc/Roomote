import { buildTelegramMessagePermalink } from '../telegram';

describe('buildTelegramMessagePermalink', () => {
  it('builds a t.me/c permalink for a supergroup chat id and message id', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '-100456789',
        messageId: '42',
      }),
    ).toBe('https://t.me/c/456789/42');
  });

  it('includes the thread id for forum topics when provided', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '-100456789',
        threadId: '7',
        messageId: '42',
      }),
    ).toBe('https://t.me/c/456789/7/42');
  });

  it('returns null for personal chat / bot DM ids when no bot username is provided', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '9876543',
        messageId: '42',
      }),
    ).toBeNull();
  });

  it('falls back to the bot DM link for personal chats when a bot username is provided', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '9876543',
        messageId: '42',
        botUsername: 'roomote_bot',
      }),
    ).toBe('https://t.me/roomote_bot');
  });

  it('strips a leading @ from the bot username when building the DM link', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '9876543',
        botUsername: '@roomote_bot',
      }),
    ).toBe('https://t.me/roomote_bot');
  });

  it('returns null when the chat id is missing even with a bot username', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '   ',
        botUsername: 'roomote_bot',
      }),
    ).toBeNull();
  });

  it('returns null when the chat id or message id is missing', () => {
    expect(
      buildTelegramMessagePermalink({
        chatId: '-100456789',
        messageId: '',
      }),
    ).toBeNull();
    expect(
      buildTelegramMessagePermalink({
        chatId: '   ',
        messageId: '42',
      }),
    ).toBeNull();
  });
});
