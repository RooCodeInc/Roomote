import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  getdel: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mocks,
}));

import {
  claimPendingDiscordAccountLinkTask,
  rememberPendingDiscordAccountLinkTask,
} from '../pending-account-link-task.js';

function event(id: string, receivedAt: string): DiscordGatewayEvent {
  return {
    eventId: id,
    eventType: 'MESSAGE_CREATE',
    payload: {
      id,
      channel_id: 'dm-1',
      content: id,
      author: { id: 'discord-user-1', username: 'matt' },
      mentions: [],
      attachments: [],
    },
    receivedAt,
  };
}

describe('pending Discord account-link tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses an atomic timestamp comparison so an older completion cannot replace a newer request', async () => {
    const stored = new Map<string, DiscordGatewayEvent>();
    mocks.eval.mockImplementation(
      async (
        script: string,
        keyCount: number,
        key: string,
        receivedAt: string,
        eventId: string,
        serialized: string,
        ttl: string,
      ) => {
        expect(script).toContain("redis.call('GET', KEYS[1])");
        expect(script).toContain('current.receivedAt > ARGV[1]');
        expect(script).toContain('current.eventId >= ARGV[2]');
        expect(keyCount).toBe(1);
        expect(ttl).toBe(String(10 * 60));

        const current = stored.get(key);
        if (
          current &&
          (current.receivedAt > receivedAt ||
            (current.receivedAt === receivedAt &&
              BigInt(current.eventId) >= BigInt(eventId)))
        ) {
          return 0;
        }
        stored.set(key, JSON.parse(serialized) as DiscordGatewayEvent);
        return 1;
      },
    );
    const newer = event('200', '2026-08-03T12:00:01.000Z');
    const older = event('100', '2026-08-03T12:00:00.000Z');

    await rememberPendingDiscordAccountLinkTask({
      discordUserId: 'discord-user-1',
      event: newer,
    });
    await rememberPendingDiscordAccountLinkTask({
      discordUserId: 'discord-user-1',
      event: older,
    });

    expect(
      stored.get('discord:pending_account_link_task:discord-user-1'),
    ).toEqual(newer);
  });

  it('claims and parses the stored event', async () => {
    const pending = event('200', '2026-08-03T12:00:01.000Z');
    mocks.getdel.mockResolvedValue(JSON.stringify(pending));

    await expect(
      claimPendingDiscordAccountLinkTask('discord-user-1'),
    ).resolves.toEqual(pending);
  });
});
