import EventEmitter from 'node:events';

import {
  TRPCClientError,
  createTRPCProxyClient,
  httpBatchLink,
} from '@trpc/client';
import { createWSClient, wsLink } from '@trpc/client/links/wsLink/wsLink';
import superjson from 'superjson';
import WebSocket from 'ws';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import { findFreePort } from '../../services/find-free-port';

import type { AppRouter } from '../routers';
import { createServer } from '../server';
import type { SandboxStreamEvent } from '../procedures/sandboxStream';

class FakeHarness extends EventEmitter {
  subscribe(listener: (event: unknown) => void): () => void {
    this.on('taskEvent', listener);
    return () => this.off('taskEvent', listener);
  }

  subscribeRuntimeOutput(listener: (event: unknown) => void): () => void {
    this.on('runtimeOutput', listener);
    return () => this.off('runtimeOutput', listener);
  }

  subscribeRuntimePersistedEnvelope(
    listener: (event: unknown) => void,
  ): () => void {
    this.on('runtimePersistedEnvelope', listener);
    return () => this.off('runtimePersistedEnvelope', listener);
  }

  subscribeRuntimeTurnCompleted(
    listener: (event: unknown) => void,
  ): () => void {
    this.on('runtimeTurnCompleted', listener);
    return () => this.off('runtimeTurnCompleted', listener);
  }

  sendCommand(): boolean {
    return true;
  }

  get isConnected(): boolean {
    return true;
  }

  dispose(): void {}
}

class FakeHarnessManager extends EventEmitter {
  touchKeepalive(): void {}

  getStatus() {
    return {
      phase: 'idle',
      taskStateEvent: null,
      sessionId: undefined,
      isConnected: true,
      sleepRemainingMs: null,
      lastErrorMessage: undefined,
    };
  }
}

async function startSandboxServer(
  validateToken: (token: string) => Promise<AuthTokenContext | JobTokenContext>,
  options?: {
    allowTerminal?: boolean;
    cloudJobId?: number;
    cloudJobOrgId?: string;
  },
) {
  const port = await findFreePort();
  const harness = new FakeHarness();
  const harnessManager = new FakeHarnessManager();
  const sandbox = createServer({
    port,
    workingDirectory: process.cwd(),
    userEnv: {},
    harness: harness as never,
    harnessManager: harnessManager as never,
    allowTerminal: options?.allowTerminal ?? true,
    cloudJobId: options?.cloudJobId ?? 1,
    validateToken,
  });

  return {
    harness,
    harnessManager,
    port,
    close: () => sandbox.close(),
  };
}

const validJobTokenContext = {
  cloudJobId: 1,
  userId: 'user-1',
  principal: 'user',
  tokenType: 'cj',
  version: 1,
} satisfies JobTokenContext;

const validAuthTokenContext = {
  userId: 'user-1',
  tokenType: 'auth',
  version: 1,
} satisfies AuthTokenContext;

describe('sandbox server transports', () => {
  it('allows private-network preflight requests from ngrok-hosted pages', async () => {
    const sandbox = await startSandboxServer(vi.fn());

    try {
      const response = await fetch(`http://127.0.0.1:${sandbox.port}/ws/trpc`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://roomote-matt.ngrok.app',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Private-Network': 'true',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-private-network')).toBe(
        'true',
      );
    } finally {
      await sandbox.close();
    }
  });

  it('authenticates HTTP mutations via the Authorization header', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken);

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [
          httpBatchLink({
            url: `http://127.0.0.1:${sandbox.port}/trpc`,
            transformer: superjson,
            headers: {
              Authorization: 'Bearer ok-token',
            },
          }),
        ],
      });

      const result = await client.commands.touchKeepalive.mutate();

      expect(result).toEqual({ success: true });
      expect(validateToken).toHaveBeenCalledWith('ok-token');
    } finally {
      await sandbox.close();
    }
  });

  it('rejects HTTP mutations with an unauthorized error when the header token is invalid', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken);

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [
          httpBatchLink({
            url: `http://127.0.0.1:${sandbox.port}/trpc`,
            transformer: superjson,
            headers: {
              Authorization: 'Bearer bad-token',
            },
          }),
        ],
      });

      await expect(
        client.commands.touchKeepalive.mutate(),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Unauthorized'),
        data: expect.objectContaining({
          code: 'UNAUTHORIZED',
          httpStatus: 401,
        }),
      });
    } finally {
      await sandbox.close();
    }
  });

  it('rejects HTTP mutations when a job token targets a different sandbox cloud job', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return {
        ...validJobTokenContext,
        cloudJobId: 2,
      } satisfies JobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken, {
      cloudJobId: 1,
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [
          httpBatchLink({
            url: `http://127.0.0.1:${sandbox.port}/trpc`,
            transformer: superjson,
            headers: {
              Authorization: 'Bearer ok-token',
            },
          }),
        ],
      });

      await expect(
        client.commands.touchKeepalive.mutate(),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'Token cloud job does not match sandbox cloud job',
        ),
        data: expect.objectContaining({
          code: 'UNAUTHORIZED',
          httpStatus: 401,
        }),
      });
    } finally {
      await sandbox.close();
    }
  });

  it('accepts HTTP mutations for auth tokens', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validAuthTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken, {
      cloudJobId: 1,
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [
          httpBatchLink({
            url: `http://127.0.0.1:${sandbox.port}/trpc`,
            transformer: superjson,
            headers: {
              Authorization: 'Bearer ok-token',
            },
          }),
        ],
      });

      const result = await client.commands.touchKeepalive.mutate();

      expect(result).toEqual({ success: true });
    } finally {
      await sandbox.close();
    }
  });

  it('authenticates sandboxStream subscriptions via connection params and multiplexes live events', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken);
    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${sandbox.port}/ws/trpc`,
      connectionParams: { token: 'ok-token' },
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [wsLink({ client: wsClient, transformer: superjson })],
      });

      const sandboxEvents = await new Promise<SandboxStreamEvent[]>(
        (resolve, reject) => {
          const events: SandboxStreamEvent[] = [];
          const sub = client.commands.sandboxStream.subscribe(undefined, {
            onStarted: () => {
              sandbox.harness.emit('runtimeOutput', {
                id: 'session-1:1',
                ts: Date.now(),
                eventType: 'roomote_runtime.test_event',
                role: 'assistant',
                contentBlocks: [],
                metadata: { sessionId: 'session-1', sequence: 1 },
                payload: { sessionUpdate: 'test_event' },
              });
            },
            onData: (event: SandboxStreamEvent) => {
              events.push(event);

              if (
                events.some((entry) => entry.type === 'taskStatus') &&
                events.some((entry) => entry.type === 'runtimeOutput')
              ) {
                clearTimeout(timeout);
                sub.unsubscribe();
                resolve(events);
              }
            },
            onError: (error: TRPCClientError<AppRouter>) => {
              clearTimeout(timeout);
              reject(error);
            },
          });

          const timeout = setTimeout(() => {
            sub.unsubscribe();
            reject(new Error('subscription timeout'));
          }, 5_000);
        },
      );

      expect(sandboxEvents).toContainEqual({
        type: 'taskStatus',
        status: expect.objectContaining({
          phase: 'idle',
          taskStateEvent: null,
          isConnected: true,
          sleepRemainingMs: null,
        }),
      });
      expect(sandboxEvents).toContainEqual({
        type: 'runtimeOutput',
        event: expect.objectContaining({
          id: 'session-1:1',
          eventType: 'roomote_runtime.test_event',
          metadata: expect.objectContaining({
            sessionId: 'session-1',
            sequence: 1,
          }),
        }),
      });
      expect(validateToken).toHaveBeenCalledWith('ok-token');
    } finally {
      await wsClient.close();
      await sandbox.close();
    }
  });

  it('includes the current task status when publishing usage_update events', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken);
    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${sandbox.port}/ws/trpc`,
      connectionParams: { token: 'ok-token' },
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [wsLink({ client: wsClient, transformer: superjson })],
      });

      const usageEvent = await new Promise<SandboxStreamEvent>(
        (resolve, reject) => {
          const sub = client.commands.sandboxStream.subscribe(undefined, {
            onStarted: () => {
              sandbox.harness.emit('runtimeOutput', {
                id: 'session-usage:1',
                ts: Date.now(),
                eventType: 'roomote_runtime.usage_update',
                role: 'assistant',
                kind: 'unknown',
                contentBlocks: [],
                metadata: { sessionId: 'session-usage', sequence: 1 },
                payload: {
                  sessionUpdate: 'usage_update',
                  used: 42,
                  size: 4_096,
                },
              });
            },
            onData: (event: SandboxStreamEvent) => {
              if (
                event.type === 'runtimeOutput' &&
                event.event.eventType === 'roomote_runtime.usage_update'
              ) {
                clearTimeout(timeout);
                sub.unsubscribe();
                resolve(event);
              }
            },
            onError: (error: TRPCClientError<AppRouter>) => {
              clearTimeout(timeout);
              reject(error);
            },
          });

          const timeout = setTimeout(() => {
            sub.unsubscribe();
            reject(new Error('usage_update timeout'));
          }, 5_000);
        },
      );

      expect(usageEvent).toEqual({
        type: 'runtimeOutput',
        event: expect.objectContaining({
          eventType: 'roomote_runtime.usage_update',
          payload: expect.objectContaining({
            used: 42,
            size: 4_096,
            taskStatus: expect.objectContaining({
              phase: 'idle',
              taskStateEvent: null,
              isConnected: true,
              sleepRemainingMs: null,
            }),
          }),
        }),
      });
    } finally {
      await wsClient.close();
      await sandbox.close();
    }
  });

  it('rejects websocket subscriptions when a job token targets a different sandbox cloud job', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return {
        ...validJobTokenContext,
        cloudJobId: 2,
      } satisfies JobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken, {
      cloudJobId: 1,
    });
    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${sandbox.port}/ws/trpc`,
      connectionParams: { token: 'ok-token' },
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [wsLink({ client: wsClient, transformer: superjson })],
      });

      const error = await new Promise<TRPCClientError<AppRouter>>(
        (resolve, reject) => {
          const sub = client.commands.sandboxStream.subscribe(undefined, {
            onData: () => {
              sub.unsubscribe();
              reject(new Error('expected websocket auth failure'));
            },
            onError: (wsError: TRPCClientError<AppRouter>) => resolve(wsError),
          });
        },
      );

      expect(error).toBeInstanceOf(TRPCClientError);
      expect(error.message).toMatch(
        /Token cloud job does not match sandbox cloud job|Unauthorized|not open/i,
      );
    } finally {
      await wsClient.close();
      await sandbox.close();
    }
  });

  it('rejects websocket subscriptions with an unauthorized tRPC error when connection params are invalid', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken);
    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${sandbox.port}/ws/trpc`,
      connectionParams: { token: 'bad-token' },
    });

    try {
      const client = createTRPCProxyClient<AppRouter>({
        links: [wsLink({ client: wsClient, transformer: superjson })],
      });

      const error = await new Promise<TRPCClientError<AppRouter>>(
        (resolve, reject) => {
          const sub = client.commands.sandboxStream.subscribe(undefined, {
            onData: () => {
              sub.unsubscribe();
              reject(new Error('expected websocket auth failure'));
            },
            onError: (wsError: TRPCClientError<AppRouter>) => resolve(wsError),
          });
        },
      );

      expect(error).toBeInstanceOf(TRPCClientError);
      // The server throws UNAUTHORIZED from createContext. Depending on
      // timing the client may see the tRPC error or a generic close.
      // Both are acceptable — the key invariant is that no data is emitted.
      expect(error.message).toMatch(/Unauthorized|not open/i);
    } finally {
      await wsClient.close();
      await sandbox.close();
    }
  });

  it('rejects terminal websocket upgrades when a job token targets a different sandbox cloud job', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return {
        ...validJobTokenContext,
        cloudJobId: 2,
      } satisfies JobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken, {
      cloudJobId: 1,
    });

    try {
      const response = await new Promise<{ statusCode?: number }>(
        (resolve, reject) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${sandbox.port}/ws/terminal?token=ok-token&cols=80&rows=24`,
          );

          ws.once('open', () => {
            ws.close();
            reject(new Error('expected terminal auth failure'));
          });

          ws.once('unexpected-response', (_req, res) => {
            resolve({ statusCode: res.statusCode });
          });

          ws.once('error', (error) => {
            reject(error);
          });
        },
      );

      expect(response.statusCode).toBe(401);
    } finally {
      await sandbox.close();
    }
  });

  it('rejects terminal websocket upgrades when terminal access is disabled', async () => {
    const validateToken = vi.fn(async (token: string) => {
      if (token !== 'ok-token') {
        throw new Error('bad token');
      }

      return validJobTokenContext;
    });

    const sandbox = await startSandboxServer(validateToken, {
      allowTerminal: false,
    });

    try {
      const response = await new Promise<{ statusCode?: number }>(
        (resolve, reject) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${sandbox.port}/ws/terminal?token=ok-token&cols=80&rows=24`,
          );

          ws.once('open', () => {
            ws.close();
            reject(new Error('expected terminal access to be forbidden'));
          });

          ws.once('unexpected-response', (_req, res) => {
            resolve({ statusCode: res.statusCode });
          });

          ws.once('error', (error) => {
            reject(error);
          });
        },
      );

      expect(response.statusCode).toBe(403);
      expect(validateToken).not.toHaveBeenCalled();
    } finally {
      await sandbox.close();
    }
  });
});
