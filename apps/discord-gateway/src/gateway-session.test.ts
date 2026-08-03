import { GatewayIntentBits, REST, Routes } from 'discord.js';
import {
  CloseCodes,
  WebSocketShardEvents,
  type CreateWebSocketManagerOptions,
  type SessionInfo,
} from '@discordjs/ws';

import { DiscordGatewayResumeStore } from './gateway-resume-store';
import {
  DISCORD_GATEWAY_INTENTS,
  DiscordGatewaySession,
} from './gateway-session';

describe('Discord Gateway intents', () => {
  it('subscribes to messages and reactions in guilds and DMs', () => {
    expect(DISCORD_GATEWAY_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
    ]);
  });
});

describe('DiscordGatewaySession durable resume wiring', () => {
  it('uses public @discordjs/ws callbacks and preserves state for a handoff', async () => {
    const persisted: SessionInfo = {
      sessionId: 'session-1',
      resumeURL: 'wss://resume.discord.test',
      sequence: 42,
      shardId: 0,
      shardCount: 1,
    };
    const repository = {
      find: vi.fn(async () => ({
        sessionId: persisted.sessionId,
        resumeGatewayUrl: persisted.resumeURL,
        sequence: persisted.sequence,
        shardId: persisted.shardId,
        shardCount: persisted.shardCount,
      })),
      save: vi.fn(async () => undefined),
      updateSequence: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      recordHeartbeat: vi.fn(async () => undefined),
    };
    const resumeStore = new DiscordGatewayResumeStore(
      'fingerprint',
      repository,
      60_000,
    );
    const listeners = new Map<
      WebSocketShardEvents,
      (payload: unknown) => unknown
    >();
    let managerOptions: CreateWebSocketManagerOptions | null = null;
    let restoredSession: SessionInfo | null = null;
    const destroy = vi.fn(async (options?: { code?: number }) => {
      if (!managerOptions?.updateSessionInfo) {
        throw new Error('Missing updateSessionInfo callback');
      }
      await managerOptions.updateSessionInfo(0, null);
      expect(options?.code).toBe(CloseCodes.Resuming);
    });
    const manager = {
      on: vi.fn(
        (
          event: WebSocketShardEvents,
          listener: (payload: unknown) => unknown,
        ) => {
          listeners.set(event, listener);
        },
      ),
      getShardIds: vi.fn(async () => [0]),
      connect: vi.fn(async () => {
        if (!managerOptions?.retrieveSessionInfo) {
          throw new Error('Missing retrieveSessionInfo callback');
        }
        restoredSession = await managerOptions.retrieveSessionInfo(0);
        await listeners.get(WebSocketShardEvents.Resumed)?.({ shardId: 0 });
      }),
      destroy,
    };
    const rest = {
      get: vi.fn(async () => ({ id: 'bot-1', username: 'roomote' })),
      post: vi.fn(),
    } as unknown as REST;
    const status = { update: vi.fn(async () => undefined) };
    let releaseEnqueue!: (value: boolean) => void;
    const enqueuePromise = new Promise<boolean>((resolve) => {
      releaseEnqueue = resolve;
    });
    const queue = {
      enqueue: vi.fn(() => enqueuePromise),
      depth: vi.fn(async () => 1),
    };
    const session = new DiscordGatewaySession(queue as never, status as never, {
      createRest: () => rest,
      createResumeStore: () => resumeStore,
      createManager: (options) => {
        managerOptions = options;
        return manager as never;
      },
    });

    await session.connect('bot-token', 'fingerprint');

    expect(restoredSession).toEqual(persisted);
    expect(managerOptions).toMatchObject({
      token: 'bot-token',
      intents:
        GatewayIntentBits.Guilds |
        GatewayIntentBits.GuildMessages |
        GatewayIntentBits.GuildMessageReactions |
        GatewayIntentBits.DirectMessages |
        GatewayIntentBits.DirectMessageReactions |
        GatewayIntentBits.MessageContent,
    });
    expect(repository.find).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 0,
    });
    expect(status.update).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'ready',
        connected: true,
        sessionResumed: true,
      }),
    );

    const activeManagerOptions =
      managerOptions as CreateWebSocketManagerOptions | null;
    if (
      !activeManagerOptions?.updateSessionInfo ||
      !activeManagerOptions.retrieveSessionInfo
    ) {
      throw new Error('Missing session persistence callbacks');
    }
    await activeManagerOptions.updateSessionInfo(0, {
      ...persisted,
      sequence: 43,
    });
    const dispatchPromise = Promise.resolve(
      listeners.get(WebSocketShardEvents.Dispatch)?.({
        shardId: 0,
        data: {
          op: 0,
          s: 43,
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-1',
            channel_id: 'dm-1',
            content: 'hello',
            author: { id: 'user-1', bot: false },
          },
        },
      }),
    );
    await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledOnce());
    await expect(activeManagerOptions.retrieveSessionInfo(0)).resolves.toEqual(
      persisted,
    );
    await resumeStore.flush();
    expect(repository.updateSequence).not.toHaveBeenCalled();

    releaseEnqueue(true);
    await dispatchPromise;
    await expect(activeManagerOptions.retrieveSessionInfo(0)).resolves.toEqual({
      ...persisted,
      sequence: 43,
    });
    await resumeStore.flush();
    expect(repository.updateSequence).toHaveBeenCalledWith({
      tokenFingerprint: 'fingerprint',
      shardId: 0,
      sequence: 43,
    });

    await session.disconnect();

    expect(destroy).toHaveBeenCalledOnce();
    expect(repository.clear).not.toHaveBeenCalled();
  });

  it('queues a guild message for authoritative API routing when channel lookup fails', async () => {
    const listeners = new Map<
      WebSocketShardEvents,
      (payload: unknown) => unknown
    >();
    const manager = {
      on: vi.fn(
        (
          event: WebSocketShardEvents,
          listener: (payload: unknown) => unknown,
        ) => {
          listeners.set(event, listener);
        },
      ),
      getShardIds: vi.fn(async () => [0]),
      connect: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const rest = {
      get: vi.fn(async (route: string) => {
        if (route === Routes.user()) {
          return { id: 'bot-1', username: 'roomote' };
        }
        throw new Error('temporary Discord REST failure');
      }),
      post: vi.fn(),
    } as unknown as REST;
    const resumeStore = {
      retrieve: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
      acknowledgeDispatch: vi.fn(() => true),
      recordHeartbeat: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      beginSessionHandoff: vi.fn(),
      endSessionHandoff: vi.fn(),
    } as unknown as DiscordGatewayResumeStore;
    const queue = {
      enqueue: vi.fn(async () => true),
      depth: vi.fn(async () => 1),
    };
    const status = { update: vi.fn(async () => undefined) };
    const session = new DiscordGatewaySession(queue as never, status as never, {
      createRest: () => rest,
      createResumeStore: () => resumeStore,
      createManager: () => manager as never,
    });

    await session.connect('bot-token', 'fingerprint');
    const dispatch = listeners.get(WebSocketShardEvents.Dispatch);
    if (!dispatch) throw new Error('Missing Dispatch listener');
    await dispatch({
      shardId: 0,
      data: {
        op: 0,
        s: 7,
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-thread-follow-up',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Please make one more change',
          author: { id: 'user-1', bot: false },
          mentions: [],
        },
      },
    });

    expect(rest.get).toHaveBeenCalledWith(Routes.channel('thread-1'));
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'message-thread-follow-up',
        eventType: 'MESSAGE_CREATE',
      }),
    );
    expect(resumeStore.acknowledgeDispatch).toHaveBeenCalledWith(0, 7);
    expect(session.needsReconnect()).toBe(false);
  });
});
