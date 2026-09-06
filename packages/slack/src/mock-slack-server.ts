import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import type {
  SlackEvent,
  SlackFile,
  SlackInteractivePayload,
  SlackResponse,
  SlackThreadMessage,
} from './types';

type JsonRecord = Record<string, unknown>;
type MockSlackRequestBody = JsonRecord | URLSearchParams;

type MockSlackStoredMessage = {
  channel: string;
  ts: string;
  text: string;
  thread_ts?: string;
  user: string;
  username?: string;
  bot_id?: string;
  type: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: SlackFile[];
  ephemeral?: boolean;
  reactions?: string[];
};

export type MockSlackUser = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  title?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  isAppUser?: boolean;
  updated?: number;
};

export type MockSlackChannel = {
  id: string;
  name: string;
  type?: 'public_channel' | 'private_channel' | 'im';
  isMember?: boolean;
  members?: string[];
};

export type MockSlackTeam = {
  id: string;
  domain: string;
  timezone?: string;
};

export type MockSlackManifestCredentials = {
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  verificationToken?: string;
};

export type MockSlackCreatedManifest = {
  appId: string;
  manifest: Record<string, unknown>;
};

export type MockSlackState = {
  team: MockSlackTeam;
  acceptedBotTokens?: string[];
  botUserId?: string;
  /**
   * The `B…` bot ID stamped on bot-authored messages. Real Slack uses a bot
   * ID from a different ID space than the bot's `bot_user_id`, so the mock
   * must keep these distinct — code that compares `message.bot_id` against
   * the installation's `botUserId` would pass here but fail in production.
   */
  botId?: string;
  channels: MockSlackChannel[];
  users: MockSlackUser[];
  messages?: MockSlackStoredMessage[];
  agentSessions?: Array<{
    channel: string;
    threadTs: string;
    status: string;
    title?: string;
  }>;
  /**
   * Bearer tokens accepted by app-config endpoints (`apps.manifest.create`).
   * Slack app configuration tokens live in a different token space than bot
   * tokens, so they get their own allowlist. Undefined accepts any token,
   * mirroring `acceptedBotTokens`.
   */
  acceptedConfigTokens?: string[];
  /** Credential overrides returned by `apps.manifest.create`. */
  manifestCredentials?: MockSlackManifestCredentials;
  /** Apps created through `apps.manifest.create`, oldest first. */
  createdManifests?: MockSlackCreatedManifest[];
  /** Manifest replacements applied through `apps.manifest.update`. */
  updatedManifests?: MockSlackCreatedManifest[];
  /** Controls whether manifest updates report that OAuth approval is needed. */
  manifestPermissionsUpdated?: boolean;
};

export type MockSlackRoomoteTarget = {
  webhookUrl: string;
  signingSecret: string;
};

export type MockSlackReplayEvent =
  | {
      kind: 'event_callback';
      eventId: string;
      teamId?: string;
      event: SlackEvent;
    }
  | {
      kind: 'interactive';
      payload: SlackInteractivePayload;
    }
  | {
      kind: 'url_verification';
      challenge: string;
      teamId?: string;
    };

type MockSlackDispatchResult = {
  status: number;
  body: string;
};

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeState(state: MockSlackState): MockSlackState {
  const acceptedBotTokens = state.acceptedBotTokens
    ? [...state.acceptedBotTokens]
    : undefined;

  return {
    ...cloneState(state),
    ...(acceptedBotTokens ? { acceptedBotTokens } : {}),
    botUserId: state.botUserId ?? 'UMOCKBOT',
    botId: state.botId ?? 'BMOCKAPP',
    channels: state.channels.map((channel) => ({
      type: 'public_channel',
      isMember: true,
      members: [],
      ...channel,
    })),
    users: state.users.map((user) => ({ ...user })),
    messages: (state.messages ?? []).map((message) => ({
      reactions: [],
      ...message,
    })),
  };
}

function parseTs(ts: string): number {
  return Number.parseFloat(ts);
}

function sortMessages(
  messages: MockSlackStoredMessage[],
): MockSlackStoredMessage[] {
  return [...messages].sort(
    (left, right) => parseTs(left.ts) - parseTs(right.ts),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function maybeParseSlackFormValue(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

function parseManifestRecord(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : null;
    } catch {
      return null;
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseRequestBody(
  request: IncomingMessage,
  bodyText: string,
): MockSlackRequestBody {
  if (bodyText.length === 0) {
    return {};
  }

  const contentType = request.headers['content-type'] ?? '';

  if (contentType.includes('application/json')) {
    return JSON.parse(bodyText) as JsonRecord;
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(bodyText);
    return Object.fromEntries(
      Array.from(params.entries()).map(([key, value]) => [
        key,
        maybeParseSlackFormValue(value),
      ]),
    );
  }

  return JSON.parse(bodyText) as JsonRecord;
}

export class MockSlackServer {
  private server: Server | null = null;
  private state: MockSlackState;
  private readonly roomoteTarget?: MockSlackRoomoteTarget;
  private sequence = 1;
  private port: number | null = null;

  constructor({
    state,
    roomoteTarget,
  }: {
    state: MockSlackState;
    roomoteTarget?: MockSlackRoomoteTarget;
  }) {
    this.state = normalizeState(state);
    this.roomoteTarget = roomoteTarget;
  }

  public get baseUrl(): string {
    if (this.port === null) {
      throw new Error('Mock Slack server is not running.');
    }

    return `http://127.0.0.1:${this.port}`;
  }

  public getState(): MockSlackState {
    return cloneState(this.state);
  }

  public setState(state: MockSlackState): void {
    this.state = normalizeState(state);
  }

  public async start(port = 0): Promise<string> {
    if (this.server) {
      return this.baseUrl;
    }

    this.server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        text(
          response,
          500,
          error instanceof Error ? error.message : 'Unknown mock Slack error',
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve mock Slack server address.');
    }

    this.port = (address as AddressInfo).port;
    return this.baseUrl;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.port = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  public async dispatch(
    event: MockSlackReplayEvent,
  ): Promise<MockSlackDispatchResult> {
    if (!this.roomoteTarget) {
      throw new Error(
        'No Roomote webhook target configured for mock Slack replay.',
      );
    }

    if (event.kind === 'event_callback') {
      this.recordIncomingEvent(event.event);
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = this.buildDispatchBody(event);
    const signature = createHmac('sha256', this.roomoteTarget.signingSecret)
      .update(`v0:${timestamp}:${body}`, 'utf8')
      .digest('hex');

    const headers: Record<string, string> = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${signature}`,
    };

    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body,
    };

    if (event.kind === 'interactive') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(this.roomoteTarget.webhookUrl, requestInit);
    return {
      status: response.status,
      body: await response.text(),
    };
  }

  private buildDispatchBody(event: MockSlackReplayEvent): string {
    if (event.kind === 'interactive') {
      return new URLSearchParams({
        payload: JSON.stringify(event.payload),
      }).toString();
    }

    if (event.kind === 'url_verification') {
      return JSON.stringify({
        type: 'url_verification',
        challenge: event.challenge,
        team_id: event.teamId ?? this.state.team.id,
      });
    }

    return JSON.stringify({
      type: 'event_callback',
      event_id: event.eventId,
      team_id: event.teamId ?? this.state.team.id,
      event: event.event,
    });
  }

  private recordIncomingEvent(event: SlackEvent): void {
    if (
      !event.channel ||
      !event.ts ||
      !event.user ||
      typeof event.text !== 'string'
    ) {
      return;
    }

    const existingIndex = this.state.messages?.findIndex(
      (message) => message.channel === event.channel && message.ts === event.ts,
    );
    const nextMessage: MockSlackStoredMessage = {
      channel: event.channel,
      ts: event.ts,
      text: event.text,
      user: event.user,
      type: event.type === 'app_mention' ? 'message' : event.type,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
    };

    if (typeof existingIndex === 'number' && existingIndex >= 0) {
      this.state.messages?.splice(existingIndex, 1, nextMessage);
      return;
    }

    this.state.messages = [...(this.state.messages ?? []), nextMessage];
  }

  private nextTs(): string {
    const seconds = Math.floor(Date.now() / 1000);
    const microseconds = `${this.sequence}`.padStart(6, '0');
    this.sequence += 1;
    return `${seconds}.${microseconds}`;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);

    if (url.pathname.startsWith('/mock/')) {
      await this.handleControlRequest(request, response, url);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      text(response, 404, 'Not Found');
      return;
    }

    // App-config endpoints authenticate with configuration tokens instead of
    // bot tokens, so they skip the bot check and validate in their handler.
    if (
      !url.pathname.startsWith('/api/apps.manifest.') &&
      !this.isAuthorized(request)
    ) {
      json(response, 401, { ok: false, error: 'invalid_auth' });
      return;
    }

    await this.handleApiRequest(request, response, url);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const allowedTokens = this.state.acceptedBotTokens;
    if (!allowedTokens?.length) {
      return true;
    }

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return false;
    }

    const token = authorization.slice('Bearer '.length).trim();
    return allowedTokens.includes(token);
  }

  private isConfigTokenAuthorized(request: IncomingMessage): boolean {
    const allowedTokens = this.state.acceptedConfigTokens;
    if (!allowedTokens?.length) {
      return true;
    }

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return false;
    }

    const token = authorization.slice('Bearer '.length).trim();
    return allowedTokens.includes(token);
  }

  private async handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === 'GET' && url.pathname === '/mock/state') {
      json(response, 200, this.getState() as unknown as JsonRecord);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/state') {
      const body = JSON.parse(await readRequestBody(request)) as MockSlackState;
      this.setState(body);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/events') {
      const body = JSON.parse(
        await readRequestBody(request),
      ) as MockSlackReplayEvent;
      const dispatchResult = await this.dispatch(body);
      json(response, 200, {
        ok: true,
        dispatchResult,
      });
      return;
    }

    text(response, 404, 'Not Found');
  }

  private async handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const path = url.pathname.slice('/api/'.length);
    const bodyText = method === 'POST' ? await readRequestBody(request) : '';
    const jsonBody =
      method === 'POST'
        ? (parseRequestBody(request, bodyText) as JsonRecord)
        : {};

    switch (`${method} ${path}`) {
      case 'GET team.info': {
        json(response, 200, {
          ok: true,
          team: {
            id: this.state.team.id,
            domain: this.state.team.domain,
            tz: this.state.team.timezone ?? 'UTC',
          },
        });
        return;
      }

      case 'GET conversations.list': {
        const requestedTypes = new Set(
          (url.searchParams.get('types') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        );

        const channels = this.state.channels
          .filter((channel) =>
            requestedTypes.size === 0
              ? true
              : requestedTypes.has(channel.type ?? 'public_channel'),
          )
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_member: channel.isMember ?? true,
          }));

        json(response, 200, {
          ok: true,
          channels,
          response_metadata: { next_cursor: '' },
        });
        return;
      }

      case 'GET conversations.info': {
        const channel = this.state.channels.find(
          (entry) => entry.id === url.searchParams.get('channel'),
        );

        if (!channel) {
          json(response, 200, { ok: false, error: 'channel_not_found' });
          return;
        }

        json(response, 200, {
          ok: true,
          channel: {
            id: channel.id,
            name: channel.name,
            is_member: channel.isMember ?? true,
          },
        });
        return;
      }

      case 'GET conversations.members': {
        const channel = this.state.channels.find(
          (entry) => entry.id === url.searchParams.get('channel'),
        );

        if (!channel) {
          json(response, 200, { ok: false, error: 'channel_not_found' });
          return;
        }

        if (channel.isMember === false) {
          json(response, 200, { ok: false, error: 'not_in_channel' });
          return;
        }

        const members = channel.members ?? [];
        const limit = Math.max(
          1,
          Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200,
        );
        const offset = Math.max(
          0,
          Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0,
        );
        const paginatedMembers = members.slice(offset, offset + limit);
        const nextCursor =
          offset + limit < members.length ? String(offset + limit) : '';

        json(response, 200, {
          ok: true,
          members: paginatedMembers,
          response_metadata: { next_cursor: nextCursor },
        });
        return;
      }

      case 'POST apps.manifest.create': {
        // Real Slack reports Web API failures as HTTP 200 with `ok: false`.
        if (!this.isConfigTokenAuthorized(request)) {
          json(response, 200, { ok: false, error: 'invalid_auth' });
          return;
        }

        const manifestValue = jsonBody.manifest;
        let manifest: JsonRecord | null = null;

        if (typeof manifestValue === 'string') {
          try {
            const parsedManifest = JSON.parse(manifestValue);

            if (
              parsedManifest &&
              typeof parsedManifest === 'object' &&
              !Array.isArray(parsedManifest)
            ) {
              manifest = parsedManifest as JsonRecord;
            }
          } catch {
            manifest = null;
          }
        } else if (
          manifestValue &&
          typeof manifestValue === 'object' &&
          !Array.isArray(manifestValue)
        ) {
          manifest = manifestValue as JsonRecord;
        }

        if (!manifest) {
          json(response, 200, {
            ok: false,
            error: 'invalid_manifest',
            errors: [
              {
                message: 'manifest must be a JSON object',
                pointer: '/manifest',
              },
            ],
          });
          return;
        }

        const credentials = this.state.manifestCredentials ?? {};
        const appId = credentials.appId ?? 'AMOCKMANIFEST';
        const clientId = credentials.clientId ?? 'mock-manifest-client-id';

        this.state.createdManifests = [
          ...(this.state.createdManifests ?? []),
          { appId, manifest },
        ];

        json(response, 200, {
          ok: true,
          app_id: appId,
          credentials: {
            client_id: clientId,
            client_secret:
              credentials.clientSecret ?? 'mock-manifest-client-secret',
            verification_token:
              credentials.verificationToken ??
              'mock-manifest-verification-token',
            signing_secret:
              credentials.signingSecret ?? 'mock-manifest-signing-secret',
          },
          oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}`,
        });
        return;
      }

      case 'POST apps.manifest.export': {
        if (!this.isConfigTokenAuthorized(request)) {
          json(response, 200, { ok: false, error: 'invalid_auth' });
          return;
        }

        const appId =
          typeof jsonBody.app_id === 'string' ? jsonBody.app_id : '';
        const app = (this.state.createdManifests ?? []).find(
          (entry) => entry.appId === appId,
        );

        if (!app) {
          json(response, 200, { ok: false, error: 'app_not_found' });
          return;
        }

        json(response, 200, { ok: true, manifest: app.manifest });
        return;
      }

      case 'POST apps.manifest.validate': {
        if (!this.isConfigTokenAuthorized(request)) {
          json(response, 200, { ok: false, error: 'invalid_auth' });
          return;
        }

        const manifest = parseManifestRecord(jsonBody.manifest);
        if (!manifest) {
          json(response, 200, {
            ok: false,
            error: 'invalid_manifest',
            errors: [
              {
                message: 'manifest must be a JSON object',
                pointer: '/manifest',
              },
            ],
          });
          return;
        }

        json(response, 200, { ok: true, errors: [] });
        return;
      }

      case 'POST apps.manifest.update': {
        if (!this.isConfigTokenAuthorized(request)) {
          json(response, 200, { ok: false, error: 'invalid_auth' });
          return;
        }

        const appId =
          typeof jsonBody.app_id === 'string' ? jsonBody.app_id : '';
        const manifest = parseManifestRecord(jsonBody.manifest);
        const manifests = this.state.createdManifests ?? [];
        const appIndex = manifests.findIndex((entry) => entry.appId === appId);

        if (appIndex < 0) {
          json(response, 200, { ok: false, error: 'app_not_found' });
          return;
        }

        if (!manifest) {
          json(response, 200, {
            ok: false,
            error: 'invalid_manifest',
            errors: [
              {
                message: 'manifest must be a JSON object',
                pointer: '/manifest',
              },
            ],
          });
          return;
        }

        const updatedManifest = { appId, manifest };
        this.state.createdManifests = manifests.map((entry, index) =>
          index === appIndex ? updatedManifest : entry,
        );
        this.state.updatedManifests = [
          ...(this.state.updatedManifests ?? []),
          updatedManifest,
        ];

        json(response, 200, {
          ok: true,
          app_id: appId,
          permissions_updated: this.state.manifestPermissionsUpdated ?? false,
        });
        return;
      }

      case 'POST apps.manifest.delete': {
        // Real Slack reports Web API failures as HTTP 200 with `ok: false`.
        if (!this.isConfigTokenAuthorized(request)) {
          json(response, 200, { ok: false, error: 'invalid_auth' });
          return;
        }

        const appId =
          typeof jsonBody.app_id === 'string' ? jsonBody.app_id : '';
        const createdManifests = this.state.createdManifests ?? [];
        const nextCreatedManifests = createdManifests.filter(
          (createdManifest) => createdManifest.appId !== appId,
        );

        if (!appId || nextCreatedManifests.length === createdManifests.length) {
          json(response, 200, { ok: false, error: 'app_not_found' });
          return;
        }

        this.state.createdManifests = nextCreatedManifests;

        json(response, 200, { ok: true });
        return;
      }

      case 'POST conversations.open': {
        const users = String(jsonBody.users ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const existing = this.state.channels.find(
          (channel) =>
            channel.type === 'im' &&
            users.every((userId) => (channel.members ?? []).includes(userId)),
        );

        if (existing) {
          json(response, 200, { ok: true, channel: { id: existing.id } });
          return;
        }

        const id = `D${String(this.state.channels.length + 1).padStart(8, '0')}`;
        this.state.channels = [
          ...this.state.channels,
          {
            id,
            name: users.join('-') || id,
            type: 'im',
            isMember: true,
            members: users,
          },
        ];

        json(response, 200, { ok: true, channel: { id } });
        return;
      }

      case 'POST chat.postMessage': {
        const ts = this.nextTs();
        const message = this.storeOutgoingMessage({
          ts,
          payload: jsonBody,
          ephemeral: false,
        });
        json(response, 200, this.successResponse(message));
        return;
      }

      case 'POST chat.postEphemeral': {
        const ts = this.nextTs();
        const message = this.storeOutgoingMessage({
          ts,
          payload: jsonBody,
          ephemeral: true,
        });
        json(response, 200, {
          ok: true,
          message_ts: message.ts,
        });
        return;
      }

      case 'POST chat.startStream': {
        const ts = this.nextTs();
        const message = this.storeOutgoingMessage({
          ts,
          payload: {
            channel: jsonBody.channel,
            thread_ts: jsonBody.thread_ts,
            text: String(jsonBody.markdown_text ?? ''),
          },
          ephemeral: false,
        });
        json(response, 200, { ok: true, channel: message.channel, ts });
        return;
      }

      case 'POST chat.appendStream':
      case 'POST chat.stopStream': {
        const channel = String(jsonBody.channel ?? '');
        const ts = String(jsonBody.ts ?? '');
        const message = (this.state.messages ?? []).find(
          (entry) => entry.channel === channel && entry.ts === ts,
        );

        if (!message) {
          json(response, 200, { ok: false, error: 'message_not_found' });
          return;
        }

        message.text += String(jsonBody.markdown_text ?? '');
        if (Array.isArray(jsonBody.blocks)) {
          message.blocks = [...(message.blocks ?? []), ...jsonBody.blocks];
        }
        json(response, 200, { ok: true, channel, ts });
        return;
      }

      case 'POST chat.update': {
        const channel = String(jsonBody.channel ?? '');
        const ts = String(jsonBody.ts ?? '');
        const messages = this.state.messages ?? [];
        const message = messages.find(
          (entry) => entry.channel === channel && entry.ts === ts,
        );

        if (!message) {
          json(response, 200, { ok: false, error: 'message_not_found' });
          return;
        }

        message.text = String(jsonBody.text ?? message.text);
        if (Array.isArray(jsonBody.blocks)) {
          message.blocks = jsonBody.blocks;
        }
        if (Array.isArray(jsonBody.attachments)) {
          message.attachments = jsonBody.attachments;
        }

        json(response, 200, this.successResponse(message));
        return;
      }

      case 'POST chat.delete': {
        const channel = String(jsonBody.channel ?? '');
        const ts = String(jsonBody.ts ?? '');
        this.state.messages = (this.state.messages ?? []).filter(
          (entry) => !(entry.channel === channel && entry.ts === ts),
        );
        json(response, 200, { ok: true });
        return;
      }

      case 'GET conversations.replies': {
        const channel = url.searchParams.get('channel') ?? '';
        const threadTs = url.searchParams.get('ts') ?? '';
        const oldest = url.searchParams.get('oldest');
        const latest = url.searchParams.get('latest');
        const inclusive = url.searchParams.get('inclusive') === 'true';
        const threadRoot = (this.state.messages ?? []).find(
          (entry) =>
            entry.channel === channel &&
            entry.ts === threadTs &&
            !entry.thread_ts,
        );

        if (!threadRoot) {
          json(response, 200, {
            ok: false,
            error: 'thread_not_found',
          });
          return;
        }

        const messages = sortMessages(
          (this.state.messages ?? []).filter((entry) => {
            if (entry.channel !== channel) {
              return false;
            }

            const rootThreadTs = entry.thread_ts ?? entry.ts;
            if (rootThreadTs !== threadTs) {
              return false;
            }

            const numericTs = parseTs(entry.ts);
            if (oldest) {
              const oldestTs = parseTs(oldest);
              if (inclusive ? numericTs < oldestTs : numericTs <= oldestTs) {
                return false;
              }
            }
            if (latest) {
              const latestTs = parseTs(latest);
              if (inclusive ? numericTs > latestTs : numericTs >= latestTs) {
                return false;
              }
            }

            return true;
          }),
        ).map<SlackThreadMessage>((entry) => ({
          user: entry.user,
          username: entry.username,
          text: entry.text,
          ts: entry.ts,
          bot_id: entry.bot_id,
          type: entry.type,
          ...(entry.blocks ? { blocks: entry.blocks } : {}),
          ...(entry.attachments ? { attachments: entry.attachments } : {}),
          ...(entry.files ? { files: entry.files } : {}),
        }));

        json(response, 200, {
          ok: true,
          messages,
          has_more: false,
        });
        return;
      }

      case 'POST agents.sessions.setStatus':
      case 'POST agents.sessions.rename': {
        const channel = String(jsonBody.channel_id ?? '');
        const threadTs = String(jsonBody.thread_ts ?? '');
        const sessions = (this.state.agentSessions ??= []);
        let session = sessions.find(
          (entry) => entry.channel === channel && entry.threadTs === threadTs,
        );
        if (!session) {
          if (path === 'agents.sessions.rename') {
            json(response, 200, { ok: false, error: 'session_not_found' });
            return;
          }
          session = { channel, threadTs, status: String(jsonBody.status) };
          sessions.push(session);
        }
        if (path === 'agents.sessions.setStatus') {
          session.status = String(jsonBody.status);
        } else {
          session.title = String(jsonBody.title);
        }
        json(response, 200, { ok: true, title: session.title });
        return;
      }
      case 'POST reactions.add':
      case 'POST agents.sessions.setTitle':
      case 'POST assistant.threads.setStatus':
      case 'POST assistant.threads.setTitle':
      case 'POST assistant.threads.setSuggestedPrompts': {
        // Assistant thread presentation calls are accepted and ignored so the
        // Fast session activity adapter does not retry a 404 for minutes.
        json(response, 200, { ok: true });
        return;
      }
      case 'POST reactions.remove': {
        const channel = String(jsonBody.channel ?? '');
        const timestamp = String(jsonBody.timestamp ?? '');
        const name = String(jsonBody.name ?? '');
        const message = (this.state.messages ?? []).find(
          (entry) => entry.channel === channel && entry.ts === timestamp,
        );

        if (!message) {
          json(response, 200, { ok: false, error: 'message_not_found' });
          return;
        }

        const reactions = new Set(message.reactions ?? []);
        if (path === 'reactions.add') {
          reactions.add(name);
        } else {
          reactions.delete(name);
        }
        message.reactions = [...reactions];
        json(response, 200, { ok: true } satisfies SlackResponse);
        return;
      }

      case 'GET users.info': {
        const user = this.state.users.find(
          (entry) => entry.id === url.searchParams.get('user'),
        );

        if (!user) {
          json(response, 200, { ok: false, error: 'user_not_found' });
          return;
        }

        json(response, 200, {
          ok: true,
          user: {
            id: user.id,
            name: user.name,
            real_name: user.realName ?? user.displayName ?? user.name,
            deleted: user.deleted ?? false,
            is_bot: user.isBot ?? false,
            is_app_user: user.isAppUser ?? false,
            updated: user.updated ?? 0,
            profile: {
              display_name: user.displayName ?? user.name,
              real_name: user.realName ?? user.displayName ?? user.name,
              title: user.title ?? '',
              ...(user.email ? { email: user.email } : {}),
            },
          },
        });
        return;
      }

      case 'GET users.list': {
        const limit = Math.max(
          1,
          Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100,
        );
        const offset = Math.max(
          0,
          Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0,
        );
        const page = this.state.users.slice(offset, offset + limit);
        const nextOffset = offset + page.length;

        json(response, 200, {
          ok: true,
          members: page.map((user) => ({
            id: user.id,
            name: user.name,
            real_name: user.realName ?? user.displayName ?? user.name,
            deleted: user.deleted ?? false,
            is_bot: user.isBot ?? false,
            is_app_user: user.isAppUser ?? false,
            updated: user.updated ?? 0,
            profile: {
              display_name: user.displayName ?? user.name,
              real_name: user.realName ?? user.displayName ?? user.name,
              title: user.title ?? '',
              ...(user.email ? { email: user.email } : {}),
            },
          })),
          response_metadata: {
            next_cursor:
              nextOffset < this.state.users.length ? String(nextOffset) : '',
          },
        });
        return;
      }

      case 'POST chat.unfurl':
      case 'POST entity.presentDetails': {
        json(response, 200, { ok: true });
        return;
      }

      default:
        if (method === 'POST' && /^[a-z]+\.[a-zA-Z.]+$/.test(path)) {
          // Slack answers an unknown Web API method with HTTP 200 and
          // ok:false, which the WebClient surfaces immediately; a 404 would
          // make it retry with backoff for minutes and hold turn locks.
          json(response, 200, { ok: false, error: 'unknown_method' });
          return;
        }
        text(response, 404, `Unhandled mock Slack route: ${method} ${path}`);
    }
  }

  private storeOutgoingMessage({
    ts,
    payload,
    ephemeral,
  }: {
    ts: string;
    payload: JsonRecord;
    ephemeral: boolean;
  }): MockSlackStoredMessage {
    const message: MockSlackStoredMessage = {
      channel: String(payload.channel ?? ''),
      ts,
      text: String(payload.text ?? ''),
      user: this.state.botUserId ?? 'UMOCKBOT',
      bot_id: this.state.botId ?? 'BMOCKAPP',
      type: 'message',
      ...(typeof payload.thread_ts === 'string'
        ? { thread_ts: payload.thread_ts }
        : {}),
      ...(Array.isArray(payload.blocks) ? { blocks: payload.blocks } : {}),
      ...(Array.isArray(payload.attachments)
        ? { attachments: payload.attachments }
        : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
      reactions: [],
    };

    this.state.messages = [...(this.state.messages ?? []), message];
    return message;
  }

  private successResponse(message: MockSlackStoredMessage): SlackResponse {
    return {
      ok: true,
      channel: message.channel,
      ts: message.ts,
      message: {
        text: message.text,
        blocks: message.blocks,
      },
    };
  }
}
