import type { AddressInfo } from 'node:net';

import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { basicAuth } from 'hono/basic-auth';
import { showRoutes } from 'hono/dev';
import { HTTPException } from 'hono/http-exception';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { fetch as undiciFetch } from 'undici';

import {
  buildInternalRequestHosts,
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
  installGlobalObservedFetch,
  parseInternalRequestDomainSuffixes,
} from '@roomote/types';
import { Env, getDashboardPassword } from '@roomote/env';
import {
  getSandboxOidcDiscoveryPath,
  getSandboxOidcJwksPath,
} from '@roomote/auth';

import type { Variables } from './types';
import { resolveApiCorsOrigin } from './cors';
import { createSingleLineWarnLogger } from './logging';
import { captureApiException } from './monitoring/sentry';
import {
  requestObservabilityMiddleware,
  routePolicyMiddleware,
  tokenAuthMiddleware,
} from './middleware';
import {
  apiHealth,
  apiLiveness,
  controllerHealth,
  github,
  gitlab,
  gitea,
  bitbucket,
  ado,
  slack,
  linear,
  teams,
  telegram,
  discord,
  cloudDeploymentAccess,
  inference,
  tts,
  mcp,
  mcpRouting,
  mcpOAuthMetadata,
  publicRoomoteMcp,
  taskRunsRouter,
  artifactsRouter,
  taskArtifactsRouter,
  oidcRouter,
  trpc,
} from './handlers';

export type ApiApp = Hono<{ Variables: Variables }>;

export type StartApiServerOptions = {
  port?: number;
  hostname?: string;
  installObservedFetch?: boolean;
  logStartup?: boolean;
};

const PUBLIC_OIDC_PATHS = new Set([
  getSandboxOidcDiscoveryPath(),
  getSandboxOidcJwksPath(),
]);
const SELF_AUTHENTICATING_WEBHOOK_PATHS = new Set([
  '/api/webhooks/teams',
  '/api/webhooks/telegram',
  '/api/internal/discord/events',
  '/api/internal/discord/events/process',
  '/api/internal/cloud/deployment-access',
]);

type ListenOptions = {
  port: number;
  hostname?: string;
};

function isPublicOidcPath(path: string): boolean {
  return PUBLIC_OIDC_PATHS.has(path);
}

function isPublicMiddlewareBypassPath(path: string): boolean {
  return isPublicOidcPath(path) || SELF_AUTHENTICATING_WEBHOOK_PATHS.has(path);
}

function observedFetchImpl(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // The API installs an observed global fetch wrapper for outbound slow-request
  // logging. Route that wrapper through Undici directly so any custom
  // dispatcher attached by call sites (for example bodyTimeout=0 on long-lived
  // proxy streams) is still honored by the underlying transport.
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    init as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}

export function installApiObservedFetch(): void {
  installGlobalObservedFetch({
    serviceName: 'api',
    slowRequestThresholdMs: Env.API_SLOW_EXTERNAL_REQUEST_THRESHOLD_MS,
    fetchImpl: observedFetchImpl,
    log: createSingleLineWarnLogger(),
    internalHosts: buildInternalRequestHosts([
      Env.R_APP_URL,
      Env.TRPC_URL,
      Env.PREVIEW_PROXY_BASE_URL,
    ]),
    internalDomainSuffixes: parseInternalRequestDomainSuffixes(
      Env.PREVIEW_DOMAINS,
    ),
  });
}

export function createApiApp(): ApiApp {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c: Context<{ Variables: Variables }>) => {
    if (error instanceof HTTPException) {
      if (error.status >= 500) {
        // Sentry capture is a no-op when Sentry is disabled (the local-dev
        // default), so always log server-side too — a 500 must never be
        // invisible in the logs.
        console.error(
          `[api] Unhandled error ${c.req.method} ${c.req.path}:`,
          error,
        );
        captureApiException(error, c);
      }

      return error.getResponse();
    }

    console.error(
      `[api] Unhandled error ${c.req.method} ${c.req.path}:`,
      error,
    );
    captureApiException(error, c);

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  });

  /**
   * Middleware
   */

  // Uncomment this to enable verbose per-request logging.
  // app.use(logger());

  app.use('*', requestObservabilityMiddleware);

  const corsOptions = {
    origin: resolveApiCorsOrigin,
    credentials: true,
  };
  app.use('/api/*', cors(corsOptions));
  app.use('/trpc/*', cors(corsOptions));

  const tokenAuth = tokenAuthMiddleware();
  app.use('*', async (c, next) => {
    if (isPublicMiddlewareBypassPath(c.req.path)) {
      await next();
      return;
    }

    return tokenAuth(c, next);
  });

  // Central default-deny authorization gate: every request must match a
  // declared route policy (see route-policies.ts) and satisfy it before any
  // handler runs. Registered after token auth so validated auth contexts are
  // available for enforcement.
  app.use('*', routePolicyMiddleware);

  if (Env.NODE_ENV !== 'development') {
    app.use(
      '/admin',
      basicAuth({ username: 'admin', password: getDashboardPassword() }),
    );
  }

  /**
   * Routes
   */

  app.route('/', apiHealth);
  app.route('/health/api', apiHealth);
  app.route('/health/liveness', apiLiveness);
  app.route('/health/controller', controllerHealth);

  app.route('/api/webhooks/github', github);
  app.route('/api/webhooks/gitlab', gitlab);
  app.route('/api/webhooks/gitea', gitea);
  app.route('/api/webhooks/bitbucket', bitbucket);
  app.route('/api/webhooks/ado', ado);
  app.route('/api/webhooks/slack', slack);
  app.route('/api/webhooks/linear', linear);
  app.route('/api/webhooks/teams', teams);
  app.route('/api/webhooks/telegram', telegram);
  app.route('/api/internal/discord', discord);
  app.route('/api/internal/cloud', cloudDeploymentAccess);
  app.route('/api/inference', inference);
  app.route('/api/tts', tts);
  app.route('/api/mcp', mcp);
  app.route('/api/mcp-routing', mcpRouting);
  app.route('/mcp', publicRoomoteMcp);
  app.route('/', mcpOAuthMetadata);
  app.route('/api/task-runs', taskRunsRouter);
  app.route('/api/artifacts', artifactsRouter);
  app.route('/api/tasks', taskArtifactsRouter);
  app.route('/', oidcRouter);

  app.route('/trpc', trpc);

  return app;
}

function listen(
  server: ServerType,
  { port, hostname }: ListenOptions,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onListening = () => {
      cleanup();

      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('API server started without a TCP address.'));
        return;
      }

      resolve(address);
    };

    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, hostname);
  });
}

export async function startApiServer({
  port = Number(process.env.PORT || 13001),
  hostname = process.env.HOST,
  installObservedFetch = true,
  logStartup = true,
}: StartApiServerOptions = {}): Promise<{
  app: ApiApp;
  server: ServerType;
  address: AddressInfo;
}> {
  if (installObservedFetch) {
    installApiObservedFetch();
  }

  const app = createApiApp();
  const server = createAdaptorServer({ fetch: app.fetch });
  const address = await listen(server, { port, hostname });

  if (Env.NODE_ENV === 'development') {
    showRoutes(app);
  }

  if (logStartup) {
    console.info(
      formatRoomoteDeployMarker(buildRoomoteDeployMarker({ service: 'api' })),
    );
    console.log(
      `Server is running on http://${address.address}:${address.port}`,
    );
  }

  return { app, server, address };
}
