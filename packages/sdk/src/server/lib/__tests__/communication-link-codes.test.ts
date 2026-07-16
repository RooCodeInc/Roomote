const redisSetMock = vi.fn();
const redisGetdelMock = vi.fn();

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => redisSetMock(...args),
    getdel: (...args: unknown[]) => redisGetdelMock(...args),
  }),
}));

import {
  consumeDiscordLinkCode,
  createDiscordLinkCode,
  DISCORD_LINK_CODE_TTL_SECONDS,
  restoreDiscordLinkCode,
} from '../discord-link-codes';
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
} from '../telegram-link-codes';

describe('communication link codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSetMock.mockResolvedValue('OK');
    redisGetdelMock.mockResolvedValue(null);
  });

  it('namespaces Discord and Telegram codes independently', async () => {
    const discord = await createDiscordLinkCode('user-discord');
    const telegram = await createTelegramLinkCode('user-telegram');

    expect(discord.code).toMatch(/^link-[A-Za-z0-9_-]{16,}$/);
    expect(telegram.code).toMatch(/^link-[A-Za-z0-9_-]{16,}$/);
    expect(redisSetMock).toHaveBeenNthCalledWith(
      1,
      `discord:link-code:${discord.code}`,
      'user-discord',
      'EX',
      DISCORD_LINK_CODE_TTL_SECONDS,
    );
    expect(redisSetMock).toHaveBeenNthCalledWith(
      2,
      `telegram:link-code:${telegram.code}`,
      'user-telegram',
      'EX',
      DISCORD_LINK_CODE_TTL_SECONDS,
    );
  });

  it('consumes a valid Discord code exactly once through GETDEL', async () => {
    const code = 'link-abcdefghijklmnop';
    redisGetdelMock.mockResolvedValueOnce('roomote-user');

    await expect(consumeDiscordLinkCode(code)).resolves.toBe('roomote-user');
    expect(redisGetdelMock).toHaveBeenCalledWith(`discord:link-code:${code}`);
  });

  it('does not read Redis for malformed link codes', async () => {
    await expect(consumeDiscordLinkCode('bad code')).resolves.toBeNull();
    await expect(consumeTelegramLinkCode('/link')).resolves.toBeNull();
    expect(redisGetdelMock).not.toHaveBeenCalled();
  });

  it('restores a consumed Discord code with a fresh TTL', async () => {
    const code = 'link-abcdefghijklmnop';

    await restoreDiscordLinkCode(` ${code} `, 'roomote-user');

    expect(redisSetMock).toHaveBeenCalledWith(
      `discord:link-code:${code}`,
      'roomote-user',
      'EX',
      DISCORD_LINK_CODE_TTL_SECONDS,
    );
  });
});
