import { createServer, type Server } from 'node:http';

import type { DiscordGatewayEvent } from './discord-event';

type MockDiscordRequest = {
  method: string;
  path: string;
  body: unknown;
};

type MockDiscordMessage = {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  attachments: unknown[];
  components?: unknown[];
  embeds?: unknown[];
  nonce?: string;
};

type MockDiscordChannel = {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  name: string;
  type: number;
  position?: number;
  flags?: number;
  available_tags?: Array<{
    id: string;
    name: string;
    moderated: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
};

export type MockDiscordServerState = {
  requests: MockDiscordRequest[];
  messages: Record<string, MockDiscordMessage[]>;
  channels: Record<string, MockDiscordChannel>;
  registeredCommands: unknown[];
  reactions: Array<{
    channelId: string;
    messageId: string;
    emoji: string;
  }>;
  gatewayEvents: DiscordGatewayEvent[];
};

export type MockDiscordRoomoteTarget = {
  /** Roomote's internal Gateway-events endpoint, e.g. http://localhost:3001/api/internal/discord/events */
  eventsUrl: string;
  /** Value for the x-roomote-discord-gateway-secret header. */
  gatewaySecret?: string;
};

export type MockDiscordReplayEvent = {
  kind: 'message' | 'interaction';
  /** Raw MESSAGE_CREATE or INTERACTION_CREATE payload (the Gateway `d` field). */
  payload: Record<string, unknown>;
  /** Override the durable-envelope event id; defaults to payload.id. */
  eventId?: string;
};

export type MockDiscordDispatchResult = {
  status: number;
  body: string;
};

export type MockDiscordServerOptions = {
  botToken?: string;
  bot?: { id: string; username: string; globalName?: string | null };
  application?: { id: string; name: string };
  guildId?: string;
  /**
   * When set, `/mock/events` (and `dispatch`) forward durable Gateway
   * envelopes to Roomote's internal Discord events endpoint, standing in for
   * the real Gateway service.
   */
  roomoteTarget?: MockDiscordRoomoteTarget;
};

type QueuedFailure = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function readBody(init: RequestInit | undefined): Promise<unknown> {
  if (!init?.body) return undefined;
  if (typeof init.body === 'string') {
    return JSON.parse(init.body) as unknown;
  }
  return JSON.parse(await new Response(init.body).text()) as unknown;
}

/**
 * Deterministic Discord REST + forwarded-Gateway harness. Tests can inject it
 * directly as `fetch`, or start a local HTTP listener for end-to-end services.
 */
export class MockDiscordServer {
  readonly state: MockDiscordServerState = {
    requests: [],
    messages: {},
    channels: {},
    registeredCommands: [],
    reactions: [],
    gatewayEvents: [],
  };

  readonly botToken: string;
  readonly bot: { id: string; username: string; global_name: string | null };
  readonly application: {
    id: string;
    name: string;
    description: string;
    bot_public: boolean;
    verify_key: string;
    flags: number;
  };
  readonly guildId: string;
  /** Permission bitfield granted to the bot role for channel diagnostics tests. */
  botRolePermissions: bigint;
  private nextId = 1_000;
  private readonly failures: QueuedFailure[] = [];
  private server: Server | null = null;
  private readonly roomoteTarget?: MockDiscordRoomoteTarget;

  constructor(options: MockDiscordServerOptions = {}) {
    this.roomoteTarget = options.roomoteTarget;
    this.botToken = options.botToken ?? 'mock-discord-token';
    this.bot = {
      id: options.bot?.id ?? '100000000000000001',
      username: options.bot?.username ?? 'RoomoteBot',
      global_name: options.bot?.globalName ?? 'Roomote',
    };
    this.application = {
      id: options.application?.id ?? '200000000000000001',
      name: options.application?.name ?? 'Roomote',
      description: 'Mock Roomote Discord application',
      bot_public: true,
      verify_key: 'mock-verify-key',
      flags: 1 << 18,
    };
    this.guildId = options.guildId ?? '300000000000000001';
    this.botRolePermissions =
      (1n << 6n) |
      (1n << 10n) |
      (1n << 11n) |
      (1n << 14n) |
      (1n << 15n) |
      (1n << 16n) |
      (1n << 35n) |
      (1n << 38n);
    this.addChannel({
      id: '400000000000000001',
      guild_id: this.guildId,
      name: 'roomote',
      type: 0,
      position: 0,
    });
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      request?.url ?? input.toString(),
      'http://mock.discord.test',
    );
    const mergedInit: RequestInit = request
      ? {
          method: init?.method ?? request.method,
          headers: init?.headers ?? request.headers,
          body: init?.body ?? (request.body as BodyInit | null),
        }
      : (init ?? {});
    return this.handleRequest(url, mergedInit);
  };

  addChannel(channel: MockDiscordChannel): void {
    this.state.channels[channel.id] = channel;
    this.state.messages[channel.id] ??= [];
  }

  enqueueFailure(failure: QueuedFailure): void {
    this.failures.push(failure);
  }

  enqueueRateLimit(retryAfterSeconds = 0): void {
    this.enqueueFailure({
      status: 429,
      body: {
        message: 'You are being rate limited.',
        retry_after: retryAfterSeconds,
        global: false,
      },
      headers: { 'retry-after': String(retryAfterSeconds) },
    });
  }

  emitGatewayEvent(event: DiscordGatewayEvent): void {
    this.state.gatewayEvents.push(event);
  }

  /**
   * Forwards a durable Gateway envelope to Roomote's internal Discord events
   * endpoint, standing in for the real Gateway service's delivery loop.
   */
  async dispatch(
    event: MockDiscordReplayEvent,
  ): Promise<MockDiscordDispatchResult> {
    if (!this.roomoteTarget) {
      throw new Error(
        'No Roomote events target configured for mock Discord replay.',
      );
    }

    const payloadId = (event.payload as { id?: unknown }).id;
    const eventId =
      event.eventId ??
      (typeof payloadId === 'string' ? payloadId : String(this.allocateId()));
    // A replayed user message exists on "Discord" the moment it is
    // dispatched, so record it — message-anchored thread creation looks the
    // message up before starting a thread on it.
    if (event.kind !== 'interaction') {
      const message = event.payload as {
        id?: string;
        channel_id?: string;
      };
      if (
        typeof message.id === 'string' &&
        typeof message.channel_id === 'string' &&
        !this.findMessage(message.channel_id, message.id)
      ) {
        (this.state.messages[message.channel_id] ??= []).push(
          event.payload as MockDiscordMessage,
        );
      }
    }
    const envelope = {
      eventId,
      eventType:
        event.kind === 'interaction'
          ? ('INTERACTION_CREATE' as const)
          : ('MESSAGE_CREATE' as const),
      payload: event.payload,
      receivedAt: new Date().toISOString(),
    };

    const response = await fetch(this.roomoteTarget.eventsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.roomoteTarget.gatewaySecret
          ? {
              'x-roomote-discord-gateway-secret':
                this.roomoteTarget.gatewaySecret,
            }
          : {}),
      },
      body: JSON.stringify(envelope),
    });

    return {
      status: response.status,
      body: await response.text(),
    };
  }

  takeGatewayEvents(): DiscordGatewayEvent[] {
    return this.state.gatewayEvents.splice(0);
  }

  reset(): void {
    this.state.requests.splice(0);
    this.state.registeredCommands.splice(0);
    this.state.reactions.splice(0);
    this.state.gatewayEvents.splice(0);
    for (const messages of Object.values(this.state.messages)) {
      messages.splice(0);
    }
    this.failures.splice(0);
  }

  async listen(
    port = 0,
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    if (this.server)
      throw new Error('Mock Discord server is already listening.');
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const baseUrl = `http://${request.headers.host ?? '127.0.0.1'}`;
      const result = await this.handleRequest(
        new URL(request.url ?? '/', baseUrl),
        {
          method: request.method,
          headers: request.headers as HeadersInit,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        },
      );
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mock Discord server returned no TCP address.');
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}/api/v10`,
      close: async () => this.close(),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handleRequest(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();

    // Harness control endpoints; not part of the mocked Discord REST API.
    if (method === 'GET' && url.pathname === '/mock/state') {
      return jsonResponse(this.state);
    }
    if (method === 'POST' && url.pathname === '/mock/events') {
      const event = (await readBody(init)) as MockDiscordReplayEvent;
      const dispatchResult = await this.dispatch(event);
      return jsonResponse({ ok: true, dispatchResult });
    }

    const pathname = url.pathname.replace(/^\/api\/v\d+/u, '');
    const path = pathname + url.search;
    const body = await readBody(init);
    this.state.requests.push({ method, path, body });

    const failure = this.failures.shift();
    if (failure) {
      return jsonResponse(failure.body, failure.status, failure.headers);
    }

    const tokenHeader = new Headers(init.headers).get('authorization');
    const isInteractionRoute =
      path.startsWith('/interactions/') || path.startsWith('/webhooks/');
    if (!isInteractionRoute && tokenHeader !== `Bot ${this.botToken}`) {
      return jsonResponse({ message: '401: Unauthorized', code: 0 }, 401);
    }

    if (method === 'GET' && path === '/users/@me') {
      return jsonResponse({ ...this.bot, bot: true, avatar: null });
    }
    if (method === 'GET' && path === '/oauth2/applications/@me') {
      return jsonResponse(this.application);
    }
    if (method === 'GET' && pathname === '/users/@me/guilds') {
      return jsonResponse([
        { id: this.guildId, name: 'Mock Guild', icon: null, owner: false },
      ]);
    }
    if (method === 'POST' && path === '/users/@me/channels') {
      const recipientId = (body as { recipient_id?: string })?.recipient_id;
      const id = this.allocateId();
      const channel = { id, name: `DM ${recipientId ?? ''}`, type: 1 };
      this.addChannel(channel);
      return jsonResponse(channel);
    }

    const commands =
      /^\/applications\/([^/]+)(?:\/guilds\/([^/]+))?\/commands$/u.exec(path);
    if (method === 'PUT' && commands) {
      this.state.registeredCommands = Array.isArray(body) ? body : [];
      return jsonResponse(
        this.state.registeredCommands.map((command, index) => ({
          ...(command as object),
          id: String(5000 + index),
          application_id: commands[1],
        })),
      );
    }
    if (method === 'GET' && commands) {
      return jsonResponse(this.state.registeredCommands);
    }

    if (method === 'GET' && path === `/guilds/${this.guildId}/channels`) {
      return jsonResponse(
        Object.values(this.state.channels).filter(
          (channel) => channel.guild_id === this.guildId,
        ),
      );
    }
    const guildMember = /^\/guilds\/([^/]+)\/members\/([^/?]+)$/u.exec(path);
    if (method === 'GET' && guildMember && guildMember[1] === this.guildId) {
      // Real Discord rejects the literal `@me` on this route (unlike
      // /users/@me); keep the mock as strict so provider code cannot pass
      // against the mock while failing in production.
      if (guildMember[2] === '@me') {
        return jsonResponse({ message: 'Invalid Form Body', code: 50035 }, 400);
      }
      if (guildMember[2] !== this.bot.id) {
        return jsonResponse({ message: 'Unknown Member', code: 10007 }, 404);
      }
      return jsonResponse({ user: this.bot, roles: ['role-roomote'] });
    }
    if (method === 'GET' && path === `/guilds/${this.guildId}/roles`) {
      return jsonResponse([
        { id: this.guildId, permissions: '0' },
        {
          id: 'role-roomote',
          permissions: String(this.botRolePermissions),
          tags: { bot_id: this.bot.id },
        },
      ]);
    }

    const channelGet = /^\/channels\/([^/?]+)$/u.exec(path);
    if (method === 'GET' && channelGet) {
      const channel = this.state.channels[channelGet[1] ?? ''];
      return channel
        ? jsonResponse(channel)
        : jsonResponse({ message: 'Unknown Channel', code: 10003 }, 404);
    }
    if (method === 'PATCH' && channelGet) {
      const channel = this.state.channels[channelGet[1] ?? ''];
      if (!channel) {
        return jsonResponse({ message: 'Unknown Channel', code: 10003 }, 404);
      }
      Object.assign(channel, body);
      return jsonResponse(channel);
    }

    const typing = /^\/channels\/([^/]+)\/typing$/u.exec(path);
    if (method === 'POST' && typing) {
      return new Response(null, { status: 204 });
    }

    const messageThreadCreate =
      /^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/u.exec(path);
    if (method === 'POST' && messageThreadCreate) {
      const parentId = messageThreadCreate[1] ?? '';
      const messageId = messageThreadCreate[2] ?? '';
      if (!this.findMessage(parentId, messageId)) {
        return jsonResponse({ message: 'Unknown Message', code: 10008 }, 404);
      }
      // A message can only ever have one thread, and a message-anchored
      // thread reuses the source message id.
      if (this.state.channels[messageId]) {
        return jsonResponse(
          {
            message: 'A thread has already been created for this message',
            code: 160004,
          },
          400,
        );
      }
      const payload = body as { name?: string };
      const parent = this.state.channels[parentId];
      const channel: MockDiscordChannel = {
        id: messageId,
        guild_id: parent?.guild_id,
        parent_id: parentId,
        name: payload.name ?? 'New thread',
        type: parent?.type === 5 ? 10 : 11,
      };
      this.addChannel(channel);
      return jsonResponse(channel);
    }

    const threadCreate = /^\/channels\/([^/]+)\/threads$/u.exec(path);
    if (method === 'POST' && threadCreate) {
      const parentId = threadCreate[1] ?? '';
      const payload = body as {
        name?: string;
        type?: number;
        message?: Record<string, unknown>;
      };
      const channel: MockDiscordChannel & { message?: MockDiscordMessage } = {
        id: this.allocateId(),
        guild_id: this.state.channels[parentId]?.guild_id,
        parent_id: parentId,
        name: payload.name ?? 'New thread',
        type: payload.type ?? 11,
      };
      this.addChannel(channel);
      if (payload.message) {
        channel.message = this.createMessage(channel.id, payload.message);
      }
      return jsonResponse(channel);
    }

    const messages = /^\/channels\/([^/]+)\/messages(?:\?(.+))?$/u.exec(path);
    if (messages && method === 'POST') {
      return jsonResponse(
        this.createMessage(
          messages[1] ?? '',
          (body ?? {}) as Record<string, unknown>,
        ),
      );
    }
    if (messages && method === 'GET') {
      const channelId = messages[1] ?? '';
      const search = new URLSearchParams(messages[2] ?? '');
      const after = search.get('after');
      const before = search.get('before');
      let list = [...(this.state.messages[channelId] ?? [])];
      if (after) {
        list = list.filter((item) => {
          try {
            return BigInt(item.id) > BigInt(after);
          } catch {
            return item.id > after;
          }
        });
      }
      if (before) {
        list = list.filter((item) => {
          try {
            return BigInt(item.id) < BigInt(before);
          } catch {
            return item.id < before;
          }
        });
      }
      return jsonResponse(list.reverse());
    }

    const message = /^\/channels\/([^/]+)\/messages\/([^/]+)$/u.exec(path);
    if (message && method === 'GET') {
      const existing = this.findMessage(message[1] ?? '', message[2] ?? '');
      if (!existing) return jsonResponse({ message: 'Unknown Message' }, 404);
      return jsonResponse(existing);
    }
    if (message && method === 'PATCH') {
      const existing = this.findMessage(message[1] ?? '', message[2] ?? '');
      if (!existing) return jsonResponse({ message: 'Unknown Message' }, 404);
      Object.assign(existing, body);
      return jsonResponse(existing);
    }
    if (message && method === 'DELETE') {
      const list = this.state.messages[message[1] ?? ''] ?? [];
      const index = list.findIndex((item) => item.id === message[2]);
      if (index >= 0) list.splice(index, 1);
      return jsonResponse(undefined, 204);
    }

    const reaction =
      /^\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/u.exec(
        path,
      );
    if (reaction && method === 'PUT') {
      this.state.reactions.push({
        channelId: reaction[1] ?? '',
        messageId: reaction[2] ?? '',
        emoji: decodeURIComponent(reaction[3] ?? ''),
      });
      return jsonResponse(undefined, 204);
    }
    if (reaction && method === 'DELETE') {
      const channelId = reaction[1] ?? '';
      const messageId = reaction[2] ?? '';
      const emoji = decodeURIComponent(reaction[3] ?? '');
      this.state.reactions = this.state.reactions.filter(
        (item) =>
          !(
            item.channelId === channelId &&
            item.messageId === messageId &&
            item.emoji === emoji
          ),
      );
      return jsonResponse(undefined, 204);
    }

    if (
      method === 'POST' &&
      /^\/interactions\/[^/]+\/[^/]+\/callback$/u.test(path)
    ) {
      return jsonResponse(undefined, 204);
    }
    const interactionResponse =
      /^\/webhooks\/([^/]+)\/([^/]+)\/messages\/@original$/u.exec(path);
    if (interactionResponse && method === 'PATCH') {
      return jsonResponse({
        id: 'interaction-response',
        channel_id: 'interaction-channel',
        author: this.bot,
        attachments: [],
        ...(body as object),
      });
    }
    if (interactionResponse && method === 'DELETE') {
      return jsonResponse(undefined, 204);
    }

    return jsonResponse(
      { message: `Unhandled mock route: ${method} ${path}` },
      404,
    );
  }

  private allocateId(): string {
    this.nextId += 1;
    return String(this.nextId).padEnd(18, '0');
  }

  private createMessage(
    channelId: string,
    body: Record<string, unknown>,
  ): MockDiscordMessage {
    const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
    if (nonce && body.enforce_nonce === true) {
      const existing = (this.state.messages[channelId] ?? []).find(
        (message) => message.nonce === nonce,
      );
      if (existing) return existing;
    }
    const message: MockDiscordMessage = {
      id: this.allocateId(),
      channel_id: channelId,
      content: typeof body.content === 'string' ? body.content : '',
      author: { id: this.bot.id, username: this.bot.username, bot: true },
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      ...(Array.isArray(body.components)
        ? { components: body.components }
        : {}),
      ...(Array.isArray(body.embeds) ? { embeds: body.embeds } : {}),
      ...(nonce ? { nonce } : {}),
    };
    (this.state.messages[channelId] ??= []).push(message);
    return message;
  }

  private findMessage(channelId: string, messageId: string) {
    return (this.state.messages[channelId] ?? []).find(
      (message) => message.id === messageId,
    );
  }
}
