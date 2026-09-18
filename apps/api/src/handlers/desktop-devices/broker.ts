import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

import type { ServerType } from '@hono/node-server';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  DESKTOP_DEVICE_CAPTURE_TIMEOUT_MS,
  DESKTOP_DEVICE_MAX_REQUEST_BYTES,
  DESKTOP_DEVICE_MAX_RESPONSE_BYTES,
  DESKTOP_DEVICE_REQUEST_TIMEOUT_MS,
  desktopDeviceClientMessageSchema,
  desktopDeviceHelloSchema,
  type DesktopDeviceAction,
  type DesktopDeviceHello,
  type DesktopDeviceRequest,
  type DesktopDeviceToolResult,
  type McpAccessTokenContext,
} from '@roomote/types';
import {
  getRoomoteMcpResourceUrl,
  ROOMOTE_MCP_SCOPE,
  validateMcpAccessToken,
} from '@roomote/auth';
import {
  db,
  deploymentSettings,
  eq,
  getActiveDesktopDevice,
  markDesktopDeviceDisconnected,
  recordDesktopDeviceAudit,
  registerDesktopDevice,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { isRoomoteDeploymentDisabled } from '@roomote/types';
import { isPrincipalRouteRateLimited } from '../../middleware/routePolicyMiddleware';

const DESKTOP_DEVICE_BROKER_PATH = '/api/desktop/devices/connect';
const HELLO_TIMEOUT_MS = 10_000;
const REVALIDATE_INTERVAL_MS = 30_000;
const MAX_OWNER_CONNECTIONS = 5;
const MAX_CONCURRENT_UPGRADES = 50;

export class DesktopBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type DesktopDeviceStore = {
  register: typeof registerDesktopDevice;
  getActive: typeof getActiveDesktopDevice;
  disconnected: typeof markDesktopDeviceDisconnected;
  audit: typeof recordDesktopDeviceAudit;
};

type AuthenticatedDevice = { userId: string; expiresAt: number };

type PendingRequest = {
  id: string;
  action: DesktopDeviceAction;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: DesktopDeviceToolResult) => void;
  reject: (error: Error) => void;
};

type ActiveConnection = {
  socket: WebSocket;
  ownerUserId: string;
  deviceId: string;
  capabilities: Set<DesktopDeviceAction>;
  expiresAt: number;
  busy: boolean;
  pending?: PendingRequest;
  revalidateTimer: NodeJS.Timeout;
};

export type DesktopDeviceBrokerOptions = {
  instanceId: string;
  authenticate: (request: IncomingMessage) => Promise<AuthenticatedDevice>;
  store: DesktopDeviceStore;
  isRateLimited: (userId: string) => Promise<boolean>;
  now?: () => number;
};

export class DesktopDeviceBroker {
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly pendingOwnerConnections = new Map<string, number>();
  private readonly allSockets = new Set<WebSocket>();
  private inFlightUpgrades = 0;
  private readonly now: () => number;
  private webSocketServer?: WebSocketServer;
  private upgradeListener?: (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => void;

  constructor(private readonly options: DesktopDeviceBrokerOptions) {
    this.now = options.now ?? Date.now;
  }

  get instanceId(): string {
    return this.options.instanceId;
  }

  install(server: ServerType): void {
    if (this.webSocketServer)
      throw new Error('Desktop device broker is already installed');
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: DESKTOP_DEVICE_MAX_RESPONSE_BYTES,
    });
    this.webSocketServer = webSocketServer;
    this.upgradeListener = (request, socket, head) => {
      void this.handleUpgrade(webSocketServer, request, socket, head);
    };
    (server as Server).on('upgrade', this.upgradeListener);
  }

  isOnline(ownerUserId: string, deviceId: string): boolean {
    return this.connections.get(deviceId)?.ownerUserId === ownerUserId;
  }

  async request(
    ownerUserId: string,
    deviceId: string,
    request: DesktopDeviceRequest,
  ): Promise<DesktopDeviceToolResult> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ownerUserId !== ownerUserId) {
      await this.audit({
        deviceId,
        ownerUserId,
        event: 'request',
        actorUserId: ownerUserId,
        action: request.action,
        outcome: 'offline',
        errorCode: 'device_offline',
      });
      throw new DesktopBrokerError(
        'device_offline',
        'Desktop device is offline',
      );
    }
    if (connection.busy) {
      await this.audit({
        deviceId,
        ownerUserId,
        event: 'request',
        action: request.action,
        outcome: 'busy',
        errorCode: 'device_busy',
      });
      throw new DesktopBrokerError(
        'device_busy',
        'Desktop device already has an in-flight request',
      );
    }
    connection.busy = true;
    if (!connection.capabilities.has(request.action)) {
      await this.audit({
        deviceId,
        ownerUserId,
        event: 'request',
        actorUserId: ownerUserId,
        action: request.action,
        outcome: 'error',
        errorCode: 'unsupported_action',
      });
      connection.busy = false;
      throw new DesktopBrokerError(
        'unsupported_action',
        'Desktop device did not advertise this action',
      );
    }
    try {
      await this.revalidate(connection);
    } catch (error) {
      await this.audit({
        deviceId,
        ownerUserId,
        event: 'request',
        actorUserId: ownerUserId,
        action: request.action,
        outcome: 'revoked',
        errorCode:
          error instanceof DesktopBrokerError
            ? error.code
            : 'revalidation_failed',
      });
      connection.busy = false;
      if (
        error instanceof DesktopBrokerError &&
        error.code === 'device_revoked'
      ) {
        this.revoke(ownerUserId, deviceId);
      } else {
        connection.socket.close(1008, 'authorization changed');
      }
      throw error;
    }

    const id = randomUUID();
    const payload = JSON.stringify({ type: 'request', id, request });
    if (Buffer.byteLength(payload) > DESKTOP_DEVICE_MAX_REQUEST_BYTES) {
      connection.busy = false;
      throw new DesktopBrokerError(
        'request_too_large',
        'Desktop request exceeds the broker limit',
      );
    }
    const timeoutMs =
      request.action === 'capture'
        ? DESKTOP_DEVICE_CAPTURE_TIMEOUT_MS
        : DESKTOP_DEVICE_REQUEST_TIMEOUT_MS;
    const startedAt = this.now();
    await this.audit({
      deviceId,
      ownerUserId,
      event: 'request',
      actorUserId: ownerUserId,
      requestId: id,
      action: request.action,
    });

    return new Promise<DesktopDeviceToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (connection.pending?.id !== id) return;
        connection.pending = undefined;
        connection.busy = false;
        void this.audit({
          deviceId,
          ownerUserId,
          event: 'request',
          actorUserId: ownerUserId,
          requestId: id,
          action: request.action,
          outcome: 'timeout',
          durationMs: this.now() - startedAt,
          errorCode: 'device_timeout',
        });
        connection.socket.close(1008, 'request timeout');
        reject(
          new DesktopBrokerError(
            'device_timeout',
            'Desktop device request timed out',
          ),
        );
      }, timeoutMs);
      timer.unref();
      connection.pending = {
        id,
        action: request.action,
        startedAt,
        timer,
        resolve,
        reject,
      };
      const failSend = () => {
        clearTimeout(timer);
        connection.pending = undefined;
        connection.busy = false;
        reject(
          new DesktopBrokerError(
            'device_disconnected',
            'Desktop device disconnected',
          ),
        );
      };
      try {
        connection.socket.send(payload, (error) => {
          if (error) failSend();
        });
      } catch {
        failSend();
      }
    });
  }

  disconnect(
    ownerUserId: string,
    deviceId: string,
    reason = 'disconnected',
  ): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ownerUserId !== ownerUserId) return false;
    connection.socket.close(1000, reason);
    return true;
  }

  revoke(ownerUserId: string, deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ownerUserId !== ownerUserId) return false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      connection.socket.close(1000, 'revoked');
    };
    try {
      connection.socket.send(JSON.stringify({ type: 'revoke' }), (error) => {
        if (!error) {
          void this.audit({
            deviceId,
            ownerUserId,
            event: 'revoke_delivered',
            actorUserId: ownerUserId,
            outcome: 'ok',
          });
        }
        close();
      });
    } catch {
      close();
    }
    const fallback = setTimeout(close, 1_000);
    fallback.unref();
    return true;
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      this.rejectPending(
        connection,
        'server_shutdown',
        'Desktop broker is shutting down',
      );
      clearInterval(connection.revalidateTimer);
      connection.socket.close(1001, 'shutdown');
    }
    for (const socket of this.allSockets) socket.close(1001, 'shutdown');
    this.connections.clear();
    this.allSockets.clear();
    this.webSocketServer?.close();
  }

  private async handleUpgrade(
    webSocketServer: WebSocketServer,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== DESKTOP_DEVICE_BROKER_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (this.inFlightUpgrades >= MAX_CONCURRENT_UPGRADES) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    this.inFlightUpgrades += 1;
    let auth: AuthenticatedDevice;
    try {
      auth = await this.options.authenticate(request);
    } catch (error) {
      void this.audit({
        event: 'rejected',
        outcome: 'error',
        errorCode:
          error instanceof DesktopBrokerError ? error.code : 'unauthorized',
      });
      rejectUpgrade(
        socket,
        error instanceof DesktopBrokerError && error.code === 'forbidden'
          ? 403
          : 401,
        'Unauthorized',
      );
      return;
    } finally {
      this.inFlightUpgrades -= 1;
    }
    if (await this.options.isRateLimited(auth.userId)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    const ownerCount = [...this.connections.values()].filter(
      (connection) => connection.ownerUserId === auth.userId,
    ).length;
    const pendingCount = this.pendingOwnerConnections.get(auth.userId) ?? 0;
    if (ownerCount + pendingCount >= MAX_OWNER_CONNECTIONS) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    this.pendingOwnerConnections.set(auth.userId, pendingCount + 1);
    let released = false;
    const releasePending = () => {
      if (released) return;
      released = true;
      const remaining =
        (this.pendingOwnerConnections.get(auth.userId) ?? 1) - 1;
      if (remaining > 0)
        this.pendingOwnerConnections.set(auth.userId, remaining);
      else this.pendingOwnerConnections.delete(auth.userId);
    };
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.acceptSocket(webSocket, auth, releasePending);
    });
  }

  private acceptSocket(
    socket: WebSocket,
    auth: AuthenticatedDevice,
    releasePending: () => void,
  ): void {
    this.allSockets.add(socket);
    let connection: ActiveConnection | undefined;
    const helloTimer = setTimeout(() => {
      if (!connection) socket.close(1008, 'hello required');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on('message', (data, isBinary) => {
      void (async () => {
        if (
          isBinary ||
          rawDataLength(data) > DESKTOP_DEVICE_MAX_RESPONSE_BYTES
        ) {
          throw new DesktopBrokerError(
            'invalid_frame',
            'Desktop messages must be bounded JSON text',
          );
        }
        const parsed: unknown = JSON.parse(rawDataToString(data));
        if (!connection) {
          const hello = desktopDeviceHelloSchema.parse(parsed);
          clearTimeout(helloTimer);
          releasePending();
          connection = await this.registerConnection(socket, auth, hello);
          return;
        }
        const message = desktopDeviceClientMessageSchema.parse(parsed);
        if (message.type === 'hello')
          throw new DesktopBrokerError(
            'duplicate_hello',
            'Desktop hello was already received',
          );
        if (message.type === 'protocol_error') {
          throw new DesktopBrokerError(
            'client_protocol_error',
            'Desktop client reported a protocol error',
          );
        }
        await this.handleResponse(
          connection,
          message.id,
          message.result,
          rawDataLength(data),
        );
      })().catch((error: unknown) => {
        const code =
          error instanceof DesktopBrokerError ? error.code : 'invalid_message';
        if (connection) {
          this.rejectPending(connection, code, 'Desktop protocol failed');
          void this.audit({
            deviceId: connection.deviceId,
            ownerUserId: connection.ownerUserId,
            event: 'protocol_error',
            outcome: 'error',
            errorCode: code,
          });
        } else {
          void this.audit({
            ownerUserId: auth.userId,
            event: 'rejected',
            outcome: 'error',
            errorCode: code,
          });
        }
        socket.close(1008, 'protocol error');
      });
    });

    socket.on('close', () => {
      this.allSockets.delete(socket);
      clearTimeout(helloTimer);
      releasePending();
      if (!connection) return;
      const active = this.connections.get(connection.deviceId);
      const wasActive = active?.socket === socket;
      if (wasActive) this.connections.delete(connection.deviceId);
      clearInterval(connection.revalidateTimer);
      this.rejectPending(
        connection,
        'device_disconnected',
        'Desktop device disconnected',
      );
      if (!wasActive) return;
      void this.options.store.disconnected(
        connection.ownerUserId,
        connection.deviceId,
      );
      void this.audit({
        deviceId: connection.deviceId,
        ownerUserId: connection.ownerUserId,
        event: 'disconnected',
        outcome: 'ok',
      });
    });
  }

  private async registerConnection(
    socket: WebSocket,
    auth: AuthenticatedDevice,
    hello: DesktopDeviceHello,
  ): Promise<ActiveConnection> {
    const status = await this.options.store.register({
      id: hello.device.id,
      ownerUserId: auth.userId,
      name: hello.device.name,
      platform: hello.device.platform,
      capabilities: hello.capabilities,
      protocolVersion: hello.protocolVersion,
      instanceId: this.options.instanceId,
    });
    if (status !== 'connected') {
      await this.audit({
        deviceId: hello.device.id,
        ownerUserId: auth.userId,
        event: 'rejected',
        outcome: status === 'revoked' ? 'revoked' : 'error',
        errorCode: status,
      });
      throw new DesktopBrokerError(
        status,
        'Desktop device registration was rejected',
      );
    }

    const previous = this.connections.get(hello.device.id);
    if (previous) {
      this.rejectPending(
        previous,
        'superseded',
        'Desktop connection was superseded',
      );
      previous.socket.close(1000, 'superseded');
      clearInterval(previous.revalidateTimer);
      await this.audit({
        deviceId: hello.device.id,
        ownerUserId: auth.userId,
        event: 'superseded',
        outcome: 'ok',
      });
    }

    const connection: ActiveConnection = {
      socket,
      ownerUserId: auth.userId,
      deviceId: hello.device.id,
      capabilities: new Set(hello.capabilities),
      expiresAt: auth.expiresAt,
      busy: false,
      revalidateTimer: setInterval(() => {
        void this.revalidate(connection).catch((error: unknown) => {
          if (
            !(error instanceof DesktopBrokerError) ||
            error.code !== 'device_revoked' ||
            !this.revoke(connection.ownerUserId, connection.deviceId)
          ) {
            socket.close(1008, 'authorization expired');
          }
        });
      }, REVALIDATE_INTERVAL_MS),
    };
    connection.revalidateTimer.unref();
    this.connections.set(hello.device.id, connection);
    await this.audit({
      deviceId: hello.device.id,
      ownerUserId: auth.userId,
      event: 'connected',
      outcome: 'ok',
    });
    return connection;
  }

  private async handleResponse(
    connection: ActiveConnection,
    id: string,
    result: DesktopDeviceToolResult,
    responseBytes: number,
  ): Promise<void> {
    const pending = connection.pending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    connection.pending = undefined;
    connection.busy = false;
    try {
      assertSafeDesktopResult(result);
      await this.revalidate(connection);
      await this.audit({
        deviceId: connection.deviceId,
        ownerUserId: connection.ownerUserId,
        event: 'request',
        actorUserId: connection.ownerUserId,
        requestId: id,
        action: pending.action,
        outcome: result.isError ? 'error' : 'ok',
        durationMs: this.now() - pending.startedAt,
        responseBytes,
        ...(result.isError ? { errorCode: 'device_error' } : {}),
      });
      pending.resolve(result);
    } catch (error) {
      await this.audit({
        deviceId: connection.deviceId,
        ownerUserId: connection.ownerUserId,
        event: 'request',
        actorUserId: connection.ownerUserId,
        requestId: id,
        action: pending.action,
        outcome: 'revoked',
        durationMs: this.now() - pending.startedAt,
        responseBytes,
        errorCode:
          error instanceof DesktopBrokerError
            ? error.code
            : 'response_rejected',
      });
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      if (
        error instanceof DesktopBrokerError &&
        error.code === 'device_revoked'
      ) {
        this.revoke(connection.ownerUserId, connection.deviceId);
      } else {
        connection.socket.close(1008, 'authorization changed');
      }
    }
  }

  private async revalidate(connection: ActiveConnection): Promise<void> {
    if (this.now() >= connection.expiresAt) {
      throw new DesktopBrokerError(
        'token_expired',
        'Desktop connection token expired',
      );
    }
    const device = await this.options.store.getActive(
      connection.ownerUserId,
      connection.deviceId,
    );
    if (!device) {
      throw new DesktopBrokerError(
        'device_revoked',
        'Desktop device is revoked or unavailable',
      );
    }
    if (device.lastInstanceId !== this.options.instanceId) {
      throw new DesktopBrokerError(
        'device_on_other_instance',
        'Desktop device reconnected to another API instance',
      );
    }
  }

  private rejectPending(
    connection: ActiveConnection,
    code: string,
    message: string,
  ): void {
    connection.busy = false;
    if (!connection.pending) return;
    clearTimeout(connection.pending.timer);
    connection.pending.reject(new DesktopBrokerError(code, message));
    connection.pending = undefined;
  }

  private async audit(
    input: Parameters<DesktopDeviceStore['audit']>[0],
  ): Promise<void> {
    try {
      await this.options.store.audit(input);
    } catch (error) {
      console.error(
        '[desktop-device-broker] Could not persist audit event',
        error,
      );
    }
  }
}

const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'(=:])(?:file:\/\/|\/(?!\/)[^\s"']+|[A-Za-z]:[\\/][^\s"']+)/;

export function assertSafeDesktopResult(result: DesktopDeviceToolResult): void {
  assertNoLocalPathValue(result.structuredContent);
  for (const part of result.content) {
    if (part.type !== 'text') continue;
    try {
      assertNoLocalPathValue(JSON.parse(part.text));
    } catch (error) {
      if (error instanceof DesktopBrokerError) throw error;
      if (LOCAL_PATH_PATTERN.test(part.text)) {
        throw new DesktopBrokerError(
          'unsafe_response',
          'Desktop response exposed a local filesystem path',
        );
      }
    }
  }
}

function assertNoLocalPathValue(value: unknown): void {
  if (typeof value === 'string') {
    if (LOCAL_PATH_PATTERN.test(value)) {
      throw new DesktopBrokerError(
        'unsafe_response',
        'Desktop response exposed a local filesystem path',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoLocalPathValue(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'output') {
      throw new DesktopBrokerError(
        'unsafe_response',
        'Desktop response exposed a local output path',
      );
    }
    assertNoLocalPathValue(nested);
  }
}

let installedBroker: DesktopDeviceBroker | undefined;

export function getDesktopDeviceBroker(): DesktopDeviceBroker {
  if (!installedBroker)
    throw new Error('Desktop device broker is not installed');
  return installedBroker;
}

export function installDesktopDeviceBroker(
  server: ServerType,
): DesktopDeviceBroker {
  const broker = new DesktopDeviceBroker({
    instanceId: process.env.HOSTNAME ?? Env.R_INSTANCE_ID ?? 'api',
    authenticate: authenticateDesktopUpgrade,
    isRateLimited: (userId) =>
      isPrincipalRouteRateLimited('desktop-device-broker', userId, {
        limit: 120,
        windowSeconds: 60,
      }),
    store: {
      register: registerDesktopDevice,
      getActive: getActiveDesktopDevice,
      disconnected: markDesktopDeviceDisconnected,
      audit: recordDesktopDeviceAudit,
    },
  });
  broker.install(server);
  installedBroker = broker;
  return broker;
}

async function authenticateDesktopUpgrade(
  request: IncomingMessage,
): Promise<AuthenticatedDevice> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw new DesktopBrokerError('unauthorized', 'Bearer token required');
  }
  const token = authorization.slice(7);
  const context = await validateMcpAccessToken(token);
  const expectedResource = getRoomoteMcpResourceUrl(
    Env.R_PUBLIC_URL ?? Env.R_APP_URL,
  );
  assertDesktopMcpContext(context, expectedResource);
  const [user, deployment] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, context.userId),
      columns: { id: true, deletedAt: true },
    }),
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { metadata: true },
    }),
  ]);
  if (
    !user ||
    user.deletedAt ||
    isRoomoteDeploymentDisabled(deployment?.metadata)
  ) {
    throw new DesktopBrokerError(
      'forbidden',
      'Desktop connection is unavailable',
    );
  }
  const payload = decodeJwt(token);
  if (!payload.exp)
    throw new DesktopBrokerError('unauthorized', 'Token expiry required');
  return { userId: context.userId, expiresAt: payload.exp * 1000 };
}

export function assertDesktopMcpContext(
  context: McpAccessTokenContext,
  expectedResource: string,
): void {
  if (
    context.resource !== expectedResource ||
    !context.scopes.includes(ROOMOTE_MCP_SCOPE)
  ) {
    throw new DesktopBrokerError(
      'forbidden',
      'Roomote MCP audience and scope required',
    );
  }
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rawDataLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, part) => total + part.byteLength, 0)
    : data.byteLength;
}

function rawDataToString(data: RawData): string {
  return Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : data.toString();
}
