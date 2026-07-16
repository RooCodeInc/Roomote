import type { SessionInfo } from '@discordjs/ws';

import { DiscordGatewayResumeStore } from './gateway-resume-store';

const persistedSession: SessionInfo = {
  sessionId: 'session-1',
  resumeURL: 'wss://resume.discord.test',
  sequence: 10,
  shardId: 0,
  shardCount: 1,
};

function createRepository() {
  return {
    find: vi.fn(
      async (): Promise<{
        sessionId: string;
        resumeGatewayUrl: string;
        sequence: number;
        shardId: number;
        shardCount: number;
      } | null> => ({
        sessionId: persistedSession.sessionId,
        resumeGatewayUrl: persistedSession.resumeURL,
        sequence: persistedSession.sequence,
        shardId: persistedSession.shardId,
        shardCount: persistedSession.shardCount,
      }),
    ),
    save: vi.fn(async () => undefined),
    updateSequence: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    recordHeartbeat: vi.fn(async () => undefined),
  };
}

describe('DiscordGatewayResumeStore', () => {
  it('hydrates the public @discordjs/ws SessionInfo contract from durable state', async () => {
    const repository = createRepository();
    const store = new DiscordGatewayResumeStore(
      'fingerprint',
      repository,
      60_000,
    );

    await expect(store.retrieve(0)).resolves.toEqual(persistedSession);
    await expect(store.retrieve(0)).resolves.toEqual(persistedSession);
    expect(repository.find).toHaveBeenCalledOnce();
    expect(repository.find).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 0,
    });
  });

  it('persists a new session immediately and checkpoints only acknowledged dispatches', async () => {
    const repository = createRepository();
    repository.find.mockResolvedValueOnce(null);
    const store = new DiscordGatewayResumeStore(
      'fingerprint',
      repository,
      60_000,
    );
    await store.retrieve(0);

    await store.update(0, persistedSession);
    await store.update(0, { ...persistedSession, sequence: 11 });
    await store.update(0, { ...persistedSession, sequence: 12 });
    await store.update(0, { ...persistedSession, sequence: 13 });

    expect(repository.save).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 0,
      sessionId: 'session-1',
      resumeGatewayUrl: 'wss://resume.discord.test',
      sequence: 10,
      shardCount: 1,
    });
    // @discordjs/ws may ask to resume while the handler for sequence 11 is
    // still waiting on Redis. Never expose the socket's observed sequence in
    // that window or Discord would skip the unqueued dispatch.
    await expect(store.retrieve(0)).resolves.toMatchObject({ sequence: 10 });
    expect(repository.updateSequence).not.toHaveBeenCalled();

    await store.flush();
    expect(repository.updateSequence).not.toHaveBeenCalled();

    store.acknowledgeDispatch(0, 12);
    store.acknowledgeDispatch(0, 13);
    await store.flush();
    expect(repository.updateSequence).not.toHaveBeenCalled();

    store.acknowledgeDispatch(0, 11);
    await expect(store.retrieve(0)).resolves.toMatchObject({ sequence: 13 });
    await store.flush();
    expect(repository.updateSequence).toHaveBeenCalledOnce();
    expect(repository.updateSequence).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 0,
      sequence: 13,
    });
  });

  it('clears invalid sessions but preserves state during an intentional handoff', async () => {
    const repository = createRepository();
    const store = new DiscordGatewayResumeStore(
      'fingerprint',
      repository,
      60_000,
    );
    await store.retrieve(0);

    await store.update(0, null);
    expect(repository.clear).toHaveBeenCalledOnce();

    await store.update(0, persistedSession);
    store.beginSessionHandoff();
    await store.update(0, null);
    store.endSessionHandoff();
    expect(repository.clear).toHaveBeenCalledOnce();
  });

  it('records heartbeat acknowledgements for the matching token and shard', async () => {
    const repository = createRepository();
    const store = new DiscordGatewayResumeStore(
      'fingerprint',
      repository,
      60_000,
    );
    const acknowledgedAt = new Date('2026-07-13T12:00:00.000Z');

    await store.recordHeartbeat(2, acknowledgedAt);

    expect(repository.recordHeartbeat).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 2,
      acknowledgedAt,
    });
  });
});
