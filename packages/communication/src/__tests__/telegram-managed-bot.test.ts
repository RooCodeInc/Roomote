import { afterEach, describe, expect, it } from 'vitest';

import {
  MockTelegramServer,
  type MockTelegramState,
} from '../mock-telegram-server';
import {
  buildManagedBotDeepLink,
  generateManagedBotUsername,
  getManagedBotToken,
  isManagedBotUsername,
  isValidTelegramBotToken,
  parseTelegramManagedBotUpdate,
  registerManagerBotWebhook,
} from '../telegram-managed-bot';

const MANAGER_BOT_TOKEN = '7000000002:mock-manager-token';
const CHILD_BOT_TOKEN = '7000000003:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function managerState(): MockTelegramState {
  return {
    chats: [],
    users: [],
    managedBotTokens: { '7000000003': CHILD_BOT_TOKEN },
  };
}

describe('telegram-managed-bot', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  describe('generateManagedBotUsername', () => {
    it('produces distinct usernames within Telegram limits', () => {
      const first = generateManagedBotUsername();
      const second = generateManagedBotUsername();

      expect(first).not.toEqual(second);
      expect(first).toMatch(/^roomote_[a-z2-7]{16}_bot$/);
      expect(first.length).toBeLessThanOrEqual(32);
      expect(isManagedBotUsername(first)).toBe(true);
    });
  });

  describe('isValidTelegramBotToken', () => {
    it('accepts the bot token shape and rejects everything else', () => {
      expect(isValidTelegramBotToken(CHILD_BOT_TOKEN)).toBe(true);
      expect(isValidTelegramBotToken('not-a-token')).toBe(false);
      expect(isValidTelegramBotToken('123:short')).toBe(false);
      expect(isValidTelegramBotToken(null)).toBe(false);
      expect(isValidTelegramBotToken(42)).toBe(false);
    });
  });

  describe('buildManagedBotDeepLink', () => {
    it('builds the t.me/newbot deep link with an encoded display name', () => {
      expect(
        buildManagedBotDeepLink({
          managerBotUsername: '@RoomoteSetupBot',
          suggestedUsername: 'roomote_abc_bot',
          botName: 'Roomote (Acme)',
        }),
      ).toBe(
        'https://t.me/newbot/RoomoteSetupBot/roomote_abc_bot?name=Roomote+%28Acme%29',
      );
    });

    it('omits the name parameter when no display name is given', () => {
      expect(
        buildManagedBotDeepLink({
          managerBotUsername: 'RoomoteSetupBot',
          suggestedUsername: 'roomote_abc_bot',
        }),
      ).toBe('https://t.me/newbot/RoomoteSetupBot/roomote_abc_bot');
    });
  });

  describe('parseTelegramManagedBotUpdate', () => {
    it('extracts owner and bot identity from a managed_bot update', () => {
      const parsed = parseTelegramManagedBotUpdate({
        update_id: 1,
        managed_bot: {
          user: { id: 111000111, username: 'grace_mock' },
          bot: { id: 7000000003, is_bot: true, username: 'roomote_abc_bot' },
        },
      });

      expect(parsed).toEqual({
        ownerTelegramUserId: '111000111',
        ownerTelegramUsername: 'grace_mock',
        botUserId: '7000000003',
        botUsername: 'roomote_abc_bot',
      });
    });

    it('returns null for other update types and malformed payloads', () => {
      expect(
        parseTelegramManagedBotUpdate({ update_id: 1, message: {} }),
      ).toBeNull();
      expect(parseTelegramManagedBotUpdate(null)).toBeNull();
      expect(
        parseTelegramManagedBotUpdate({ managed_bot: { user: {} } }),
      ).toBeNull();
    });
  });

  describe('getManagedBotToken', () => {
    it('fetches the child bot token from the Bot API', async () => {
      const server = new MockTelegramServer({ state: managerState() });
      const baseUrl = await server.start();
      cleanups.push(() => server.stop());

      await expect(
        getManagedBotToken({
          managerBotToken: MANAGER_BOT_TOKEN,
          botUserId: '7000000003',
          apiBaseUrl: baseUrl,
        }),
      ).resolves.toBe(CHILD_BOT_TOKEN);
    });

    it('throws when the bot is unknown to the manager', async () => {
      const server = new MockTelegramServer({ state: managerState() });
      const baseUrl = await server.start();
      cleanups.push(() => server.stop());

      await expect(
        getManagedBotToken({
          managerBotToken: MANAGER_BOT_TOKEN,
          botUserId: '999',
          apiBaseUrl: baseUrl,
        }),
      ).rejects.toThrow(/getManagedBotToken failed/);
    });
  });

  describe('registerManagerBotWebhook', () => {
    it('registers a webhook restricted to managed_bot updates', async () => {
      const server = new MockTelegramServer({ state: managerState() });
      const baseUrl = await server.start();
      cleanups.push(() => server.stop());

      await registerManagerBotWebhook({
        managerBotToken: MANAGER_BOT_TOKEN,
        webhookUrl: 'https://example.com/api/webhooks/telegram-manager',
        webhookSecret: 'shh',
        apiBaseUrl: baseUrl,
      });

      expect(server.getState().webhook).toEqual({
        url: 'https://example.com/api/webhooks/telegram-manager',
        secretToken: 'shh',
        allowedUpdates: ['managed_bot'],
      });
    });
  });
});
