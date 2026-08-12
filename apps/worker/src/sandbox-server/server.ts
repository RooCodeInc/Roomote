import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import type {
  AuthTokenContext,
  CodingHarness,
  RunTokenContext,
} from '@roomote/types';

import type { HarnessLogger } from '../logging';
import type { WorkerEnv } from '../env';
import type {
  ActorMismatchPolicy,
  PrepareActorScopedTurnResult,
} from '../run-task/prepare-actor-scoped-turn';
import type { Harness } from './lib/harness';
import type { HarnessManager } from './lib/harness-manager';
import { TerminalManager } from './lib/terminal-manager';

import { appRouter } from './routers';

function getBearerToken(request: Request): string | undefined {
  const authHeader = request.headers.get('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return undefined;
}

function authorizeSandboxToken(
  auth: AuthTokenContext | RunTokenContext,
  options: {
    runId?: number;
  },
): AuthTokenContext | RunTokenContext {
  const { runId } = options;

  if ('runId' in auth && runId !== undefined && auth.runId !== runId) {
    throw new Error('Token task run does not match sandbox task run');
  }

  return auth;
}

async function assertValidToken(
  token: string | undefined,
  validateToken:
    | ((token: string) => Promise<AuthTokenContext | RunTokenContext>)
    | undefined,
  logPrefix: string,
  options: {
    runId?: number;
  },
): Promise<AuthTokenContext | RunTokenContext | null> {
  if (!validateToken) {
    return null;
  }

  if (!token) {
    console.error(`${logPrefix} Unauthorized: No token found in request`);
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Unauthorized: No token provided',
    });
  }

  try {
    const auth = await validateToken(token);
    return authorizeSandboxToken(auth, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `${logPrefix} Unauthorized: Token validation failed: ${reason}`,
    );

    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: `Unauthorized: ${reason}`,
    });
  }
}

export function createServer({
  port,
  workingDirectory,
  harnessLogger,
  harness,
  harnessManager,
  validateToken,
  userEnv,
  workerEnv,
  allowTerminal = false,
  runId,
  taskRunTaskId,
  slackReplySatisfactionStateFile,
  codingHarness,
  taskRuntime,
  prepareActorScopedTurn,
  applyTaskModelSettingsUpdate,
}: {
  /** Port to listen on. */
  port: number;
  /** Working directory for terminal sessions. */
  workingDirectory: string;
  /** Harness logger for sandbox procedures. */
  harnessLogger?: HarnessLogger;
  /** Explicit env for user-facing processes (terminal sessions). */
  userEnv: Record<string, string> | (() => Record<string, string>);
  /** Mutable worker env manager used for live env reloads. */
  workerEnv?: WorkerEnv;
  /** Whether user-facing terminal websocket sessions are allowed. */
  allowTerminal?: boolean;
  /** Harness for runtime communication. */
  harness: Harness;
  /** HarnessManager for task lifecycle control. */
  harnessManager: HarnessManager;
  /** Task run ID for the current worker session. */
  runId?: number;
  /** Stable task ID for the current task run (tasks.id). */
  taskRunTaskId?: string;
  /** Path to the Slack reply satisfaction state file for Slack-originated jobs. */
  slackReplySatisfactionStateFile?: string;
  /** Effective coding harness for the current worker session. */
  codingHarness?: CodingHarness;
  /** Task runtime home/env for locating harness credential files. */
  taskRuntime?: {
    homeDir: string;
    runtimeEnv: Record<string, string | undefined>;
  };
  /** Refresh actor-scoped integrations before delivering the next turn. */
  prepareActorScopedTurn?: (
    targetUserId?: string,
    options?: {
      allowMcpReconnect?: boolean;
      deferReconnectUntilTurnBoundary?: boolean;
      onMismatch?: ActorMismatchPolicy;
    },
  ) => Promise<PrepareActorScopedTurnResult>;
  /**
   * Re-read the run's persisted model settings and apply them to the live
   * harness (restart now, or defer to the next turn boundary).
   */
  applyTaskModelSettingsUpdate?: () => Promise<{
    application: 'restarted' | 'deferred' | 'unavailable';
  }>;
  /**
   * Token validator.
   * For tRPC: reads `Authorization: Bearer <token>` header.
   * For WebSocket: reads `connectionParams.token`.
   */
  validateToken: (token: string) => Promise<AuthTokenContext | RunTokenContext>;
}) {
  const baseContext = (auth: AuthTokenContext | RunTokenContext | null) => ({
    workingDirectory,
    harnessLogger,
    harness,
    harnessManager,
    auth,
    runId,
    taskRunTaskId,
    slackReplySatisfactionStateFile,
    codingHarness,
    workerEnv,
    taskRuntime,
    prepareActorScopedTurn,
    applyTaskModelSettingsUpdate,
  });

  const app = new Hono();

  // Add Private Network Access to all responses before CORS handles preflight.
  // This is needed when accessing localhost from a public origin (e.g., ngrok).
  app.use('/*', async (c, next) => {
    c.header('Access-Control-Allow-Private-Network', 'true');
    await next();
  });

  // Enable CORS for all origins.
  app.use(
    '/*',
    cors({
      origin: '*',
      credentials: false,
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['Content-Length'],
    }),
  );

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      harness: { connected: harness.isConnected },
    }),
  );

  app.all('/trpc/*', async (c) => {
    return fetchRequestHandler({
      endpoint: '/trpc',
      req: c.req.raw,
      router: appRouter,
      createContext: async () => {
        const auth = await assertValidToken(
          getBearerToken(c.req.raw),
          validateToken,
          '[SandboxServer]',
          { runId },
        );

        return baseContext(auth);
      },
    });
  });

  const server = serve({ fetch: app.fetch, port }, ({ address, port }) => {
    const url = `http://${address === '::' ? 'localhost' : address}:${port}`;
    console.log(`[SandboxServer] Listening on ${url}`);
    console.log(`[SandboxServer] Working directory: ${workingDirectory}`);
  });

  // Attach WebSocket servers for terminal sessions and tRPC.
  const terminalWss = new WebSocketServer({ noServer: true });
  const terminalManager = new TerminalManager(workingDirectory, userEnv);

  // tRPC WebSocket server — used by the web client for multiplexed
  // subscriptions without exhausting browser HTTP connection limits.
  const trpcWss = new WebSocketServer({ noServer: true });

  const trpcWssHandler = applyWSSHandler({
    wss: trpcWss,
    router: appRouter,
    createContext: async ({ info }) => {
      // tRPC sends ws connection params in the first message after upgrade.
      const auth = await assertValidToken(
        typeof info.connectionParams?.token === 'string'
          ? info.connectionParams.token
          : undefined,
        validateToken,
        '[WebSocketServer]',
        { runId },
      );

      return baseContext(auth);
    },
    keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 5_000 },
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);

    if (url.pathname === '/ws/trpc') {
      // tRPC WS — auth handled inside createContext above.
      trpcWss.handleUpgrade(request, socket, head, (ws) => {
        trpcWss.emit('connection', ws, request);
      });
      return;
    }

    if (url.pathname === '/ws/terminal') {
      if (!allowTerminal) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const upgradeAndConnect = () => {
        terminalWss.handleUpgrade(request, socket, head, (ws) =>
          terminalManager.handleConnection(ws, url.searchParams),
        );
      };

      if (!validateToken) {
        upgradeAndConnect();
        return;
      }

      const token = url.searchParams.get('token');

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      validateToken(token)
        .then((auth) => {
          authorizeSandboxToken(auth, { runId });
          upgradeAndConnect();
        })
        .catch((error) => {
          console.error(
            `[WebSocketServer] Unauthorized: Token validation failed: ${error instanceof Error ? error.message : String(error)}`,
          );

          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        });

      return;
    }

    socket.destroy();
  });

  return {
    app,
    server,
    harness,
    close: async () => {
      console.log('[SandboxServer] Shutting down...');
      terminalManager.dispose();
      trpcWssHandler.broadcastReconnectNotification();

      for (const client of trpcWss.clients) {
        client.terminate();
      }

      for (const client of terminalWss.clients) {
        client.terminate();
      }

      await Promise.allSettled([
        new Promise<void>((resolve) => {
          trpcWss.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          terminalWss.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
      ]);

      harness.dispose();
    },
  };
}
