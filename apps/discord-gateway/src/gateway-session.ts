import { GatewayIntentBits, REST, Routes } from 'discord.js';
import {
  CloseCodes,
  WebSocketManager,
  WebSocketShardEvents,
  type CreateWebSocketManagerOptions,
} from '@discordjs/ws';

import { handleGatewayDispatch } from './dispatch';
import { enqueueDiscordInboundWithRetry } from './enqueue-retry';
import { DiscordGatewayChannelCache } from './gateway-channel-cache';
import { DiscordGatewayResumeStore } from './gateway-resume-store';
import type { DiscordInboundQueue } from './inbound-queue';
import type { GatewayStatusStore } from './status';

export const DISCORD_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
];

const MAX_PENDING_DISPATCHES = 100;

type GatewayManager = Pick<
  WebSocketManager,
  'on' | 'getShardIds' | 'connect' | 'destroy'
>;

type DiscordGatewaySessionDependencies = {
  createRest?: (botToken: string) => REST;
  createManager?: (options: CreateWebSocketManagerOptions) => GatewayManager;
  createResumeStore?: (tokenFingerprint: string) => DiscordGatewayResumeStore;
};

type RawBotIdentity = {
  id?: string;
  username?: string;
};

type RawMessageDispatch = {
  channel_id?: string;
  guild_id?: string;
};

type DispatchConnectionState = {
  abortController: AbortController;
  pendingDispatches: number;
};

function createRest(botToken: string): REST {
  const configuredApiBase = process.env.DISCORD_API_BASE_URL?.replace(
    /\/+$/u,
    '',
  ).replace(/\/v\d+$/u, '');
  return new REST({
    version: '10',
    ...(configuredApiBase ? { api: configuredApiBase } : {}),
  }).setToken(botToken);
}

function createManager(options: CreateWebSocketManagerOptions): GatewayManager {
  return new WebSocketManager(options);
}

function combinedIntents(): number {
  return DISCORD_GATEWAY_INTENTS.reduce(
    (intents, intent) => intents | intent,
    0,
  );
}

export class DiscordGatewaySession {
  private manager: GatewayManager | null = null;
  private resumeStore: DiscordGatewayResumeStore | null = null;
  private channelCache = new DiscordGatewayChannelCache();
  private botUserId: string | undefined;
  private expectedShardIds = new Set<number>();
  private connectedShardIds = new Set<number>();
  private dispatchState: DispatchConnectionState | null = null;
  private reconnectRequired = false;
  private disconnecting = false;

  constructor(
    private readonly queue: DiscordInboundQueue,
    private readonly status: GatewayStatusStore,
    private readonly dependencies: DiscordGatewaySessionDependencies = {},
  ) {}

  async connect(botToken: string, tokenFingerprint: string): Promise<void> {
    const rest = (this.dependencies.createRest ?? createRest)(botToken);
    const identity = (await rest.get(Routes.user())) as RawBotIdentity;
    if (!identity.id || !identity.username) {
      throw new Error('Discord returned an incomplete bot identity');
    }

    this.botUserId = identity.id;
    this.channelCache = new DiscordGatewayChannelCache();
    this.connectedShardIds.clear();
    const dispatchState: DispatchConnectionState = {
      abortController: new AbortController(),
      pendingDispatches: 0,
    };
    this.dispatchState = dispatchState;
    this.reconnectRequired = false;
    this.disconnecting = false;

    const resumeStore = (
      this.dependencies.createResumeStore ??
      ((fingerprint: string) => new DiscordGatewayResumeStore(fingerprint))
    )(tokenFingerprint);
    this.resumeStore = resumeStore;

    const manager = (this.dependencies.createManager ?? createManager)({
      token: botToken,
      intents: combinedIntents(),
      rest,
      retrieveSessionInfo: (shardId) => resumeStore.retrieve(shardId),
      updateSessionInfo: (shardId, session) =>
        resumeStore.update(shardId, session),
    });
    this.manager = manager;

    manager.on(WebSocketShardEvents.Dispatch, async ({ data, shardId }) => {
      if (
        dispatchState.abortController.signal.aborted ||
        this.reconnectRequired
      ) {
        return;
      }
      if (dispatchState.pendingDispatches >= MAX_PENDING_DISPATCHES) {
        this.markReconnectRequired(dispatchState);
        await this.status.update({
          lastError:
            'Discord inbound backpressure limit reached; reconnecting to replay uncheckpointed events',
        });
        return;
      }

      dispatchState.pendingDispatches += 1;
      try {
        this.channelCache.ingest(data);
        let enqueueUnknownGuildChannel = false;
        if (data.t === 'MESSAGE_CREATE') {
          const message = data.d as RawMessageDispatch;
          if (message.guild_id && message.channel_id) {
            try {
              const channel = await this.channelCache.fetch(
                message.channel_id,
                rest,
              );
              enqueueUnknownGuildChannel = channel === undefined;
            } catch (error) {
              // Do not classify and checkpoint an unmentioned message without
              // knowing whether it belongs to a Roomote task thread. Queue it
              // durably so the API can retry an authoritative channel lookup.
              enqueueUnknownGuildChannel = true;
              await this.status.update({
                lastError: `Discord channel lookup failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }

        await handleGatewayDispatch(data, {
          rest,
          getBotUserId: () => this.botUserId,
          getCachedChannel: (channelId) => this.channelCache.get(channelId),
          enqueueUnknownGuildChannel,
          enqueue: async (envelope) => {
            const enqueued = await enqueueDiscordInboundWithRetry({
              enqueue: () => this.queue.enqueue(envelope),
              signal: dispatchState.abortController.signal,
            });
            if (enqueued) {
              await this.status.update({
                queueDepth: await this.queue.depth(),
                lastEventAt: envelope.receivedAt,
              });
            }
            return enqueued;
          },
        });
        if (!resumeStore.acknowledgeDispatch(shardId, data.s)) {
          this.markReconnectRequired(dispatchState);
          await this.status.update({
            lastError:
              'Discord resume checkpoint backlog reached its limit; reconnecting to replay uncheckpointed events',
          });
        }
      } catch (error) {
        if (!dispatchState.abortController.signal.aborted) {
          this.markReconnectRequired(dispatchState);
          await this.status.update({
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        dispatchState.pendingDispatches -= 1;
      }
    });

    manager.on(WebSocketShardEvents.Ready, async ({ data, shardId }) => {
      this.connectedShardIds.add(shardId);
      this.botUserId = data.user?.id ?? this.botUserId;
      const botUsername = data.user?.username ?? identity.username;
      console.info(
        `[discord-gateway] ready as ${botUsername} (${this.botUserId}) on shard ${shardId}`,
      );
      await this.status.update({
        phase: 'ready',
        ready: true,
        connected: this.allShardsConnected(),
        configured: true,
        botUserId: this.botUserId,
        botUsername,
        sessionResumed: false,
        lastError: undefined,
      });
    });

    manager.on(WebSocketShardEvents.Resumed, async ({ shardId }) => {
      this.connectedShardIds.add(shardId);
      console.info(
        `[discord-gateway] resumed durable Discord session on shard ${shardId}`,
      );
      await this.status.update({
        phase: 'ready',
        ready: true,
        connected: this.allShardsConnected(),
        configured: true,
        botUserId: this.botUserId,
        botUsername: identity.username,
        sessionResumed: true,
        lastError: undefined,
      });
    });

    manager.on(WebSocketShardEvents.Closed, async ({ code, shardId }) => {
      this.connectedShardIds.delete(shardId);
      console.warn(`[discord-gateway] shard ${shardId} disconnected (${code})`);
      if (!this.disconnecting) {
        await this.status.update({
          phase: 'reconnecting',
          ready: false,
          connected: this.allShardsConnected(),
        });
      }
    });

    manager.on(
      WebSocketShardEvents.HeartbeatComplete,
      async ({ ackAt, shardId }) => {
        await resumeStore
          .recordHeartbeat(shardId, new Date(ackAt))
          .catch((error) =>
            this.status.update({
              lastError: `Discord heartbeat persistence failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
      },
    );

    manager.on(WebSocketShardEvents.Error, async ({ error }) => {
      console.error(`[discord-gateway] client error: ${error.message}`);
      await this.status.update({ lastError: error.message });
    });

    await this.status.update({
      phase: 'connecting',
      configured: true,
      connected: false,
      ready: false,
      botUserId: identity.id,
      botUsername: identity.username,
      sessionResumed: false,
    });
    this.expectedShardIds = new Set(await manager.getShardIds());
    await manager.connect();
  }

  async disconnect(): Promise<void> {
    const manager = this.manager;
    const resumeStore = this.resumeStore;
    const dispatchState = this.dispatchState;
    this.manager = null;
    this.resumeStore = null;
    this.dispatchState = null;
    this.disconnecting = true;
    dispatchState?.abortController.abort(
      new Error('Discord Gateway connection is handing off'),
    );

    if (manager && resumeStore) {
      try {
        await resumeStore.flush();
      } catch (error) {
        await this.status.update({
          lastError: `Discord resume-state flush failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      resumeStore.beginSessionHandoff();
      try {
        await manager.destroy({
          code: CloseCodes.Resuming,
          reason: 'Roomote Discord Gateway handoff',
        });
      } catch (error) {
        await this.status.update({
          lastError: `Discord Gateway disconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        resumeStore.endSessionHandoff();
      }
    }

    this.connectedShardIds.clear();
    this.expectedShardIds.clear();
    this.botUserId = undefined;
    this.disconnecting = false;
    await this.status.update({
      connected: false,
      ready: false,
      botUserId: undefined,
      botUsername: undefined,
    });
  }

  needsReconnect(): boolean {
    return this.reconnectRequired;
  }

  private markReconnectRequired(state: DispatchConnectionState): void {
    if (this.dispatchState === state) {
      this.reconnectRequired = true;
    }
  }

  private allShardsConnected(): boolean {
    return (
      this.expectedShardIds.size > 0 &&
      [...this.expectedShardIds].every((shardId) =>
        this.connectedShardIds.has(shardId),
      )
    );
  }
}
