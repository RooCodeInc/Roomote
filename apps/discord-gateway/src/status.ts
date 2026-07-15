import { createServer, type Server } from 'node:http';

import type { Redis } from '@roomote/redis';

const DISCORD_GATEWAY_STATUS_KEY = 'discord:gateway:status';

type DiscordGatewayPhase =
  | 'starting'
  | 'standby'
  | 'awaiting_configuration'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'error';

type DiscordGatewayStatus = {
  phase: DiscordGatewayPhase;
  live: boolean;
  ready: boolean;
  leader: boolean;
  configured: boolean;
  connected: boolean;
  forwardingReady: boolean;
  sessionResumed: boolean;
  queueDepth: number;
  botUserId?: string;
  botUsername?: string;
  lastEventAt?: string;
  lastForwardedAt?: string;
  lastError?: string;
  updatedAt: string;
};

export class GatewayStatusStore {
  private status: DiscordGatewayStatus = {
    phase: 'starting',
    live: true,
    ready: false,
    leader: false,
    configured: false,
    connected: false,
    forwardingReady: false,
    sessionResumed: false,
    queueDepth: 0,
    updatedAt: new Date().toISOString(),
  };

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  get(): DiscordGatewayStatus {
    return { ...this.status };
  }

  async update(
    patch: Partial<Omit<DiscordGatewayStatus, 'updatedAt'>>,
    options: { publish?: boolean } = {},
  ): Promise<void> {
    const next = {
      ...this.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    next.ready =
      next.live &&
      next.leader &&
      next.configured &&
      next.connected &&
      next.forwardingReady;
    this.status = next;
    if (options.publish !== false) {
      await this.publish();
    }
  }

  async publish(): Promise<void> {
    await this.redis.set(
      DISCORD_GATEWAY_STATUS_KEY,
      JSON.stringify(this.status),
      'EX',
      this.ttlSeconds,
    );
  }
}

export function startHealthServer(
  port: number,
  getStatus: () => DiscordGatewayStatus,
): Server {
  const server = createServer((request, response) => {
    const status = getStatus();
    const path = request.url?.split('?', 1)[0];

    if (path === '/health/liveness') {
      response.writeHead(status.live ? 200 : 503, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(status));
      return;
    }

    if (path === '/health' || path === '/health/readiness') {
      response.writeHead(status.ready ? 200 : 503, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(status));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0');
  return server;
}
