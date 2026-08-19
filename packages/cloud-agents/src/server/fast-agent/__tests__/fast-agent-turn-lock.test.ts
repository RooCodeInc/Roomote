import { buildFastAgentTurnLockKey } from '../fast-agent-turn-lock';

describe('Fast conversation turn locking', () => {
  it('serializes one stable conversation across reply destination changes', () => {
    const original = buildFastAgentTurnLockKey({
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-1' },
    });
    const moved = buildFastAgentTurnLockKey({
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-2', threadId: 'thread-2' },
    });

    expect(moved).toBe(original);
  });

  it('isolates provider and workspace identities', () => {
    const base = {
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-1', threadId: 'conversation-1' },
    } as const;

    expect(
      new Set([
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'slack',
          workspaceId: 'workspace-1',
        }),
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'slack',
          workspaceId: 'workspace-2',
        }),
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'discord',
          workspaceId: 'workspace-1',
        }),
      ]).size,
    ).toBe(3);
  });
});
