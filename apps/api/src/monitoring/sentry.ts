import type { Context } from 'hono';
import * as Sentry from '@sentry/node';
import type { Scope } from '@sentry/node';

import type { Variables } from '../types';

const API_SENTRY_DSN_KEYS = ['API_SENTRY_DSN', 'SENTRY_DSN'] as const;
const MAX_SENTRY_FLUSH_MS = 2_000;

type ApiSentryScope = Pick<
  Scope,
  'setContext' | 'setLevel' | 'setTag' | 'setUser'
>;

let apiSentryInitialized = false;
let apiSentryEnabled = false;

function resolveApiSentryDsn(): string | undefined {
  for (const key of API_SENTRY_DSN_KEYS) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function resolveApiSentryEnvironment(): string | undefined {
  return (
    process.env.ROOMOTE_APP_ENV?.trim() ||
    process.env.APP_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    'development'
  );
}

function resolveApiSentryRelease(): string | undefined {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.RELEASE_VERSION?.trim() ||
    undefined
  );
}

function setRequestScope(
  scope: ApiSentryScope,
  c: Context<{ Variables: Variables }>,
): void {
  const requestId = c.req.header('x-request-id');
  const authContext = c.get('authContext');

  scope.setTag('roomote.service', 'api');
  scope.setTag('roomote.method', c.req.method);
  scope.setTag('roomote.path', c.req.path);

  if (requestId) {
    scope.setTag('roomote.request_id', requestId);
  }

  scope.setContext('request', {
    method: c.req.method,
    path: c.req.path,
    url: c.req.url,
    ...(requestId ? { requestId } : {}),
  });

  if (!authContext) {
    return;
  }

  scope.setTag('roomote.token_type', authContext.tokenType);

  // Deployment-principal job tokens carry a null userId; leave the Sentry
  // user unset for those instead of fabricating an identity.
  if ('userId' in authContext && authContext.userId !== null) {
    scope.setUser({ id: authContext.userId });
  }

  if ('cloudJobId' in authContext) {
    scope.setTag('roomote.cloud_job_id', String(authContext.cloudJobId));
  }
}

export function initApiSentry(): boolean {
  if (apiSentryInitialized) {
    return apiSentryEnabled;
  }

  const dsn = resolveApiSentryDsn();
  const environment = resolveApiSentryEnvironment();
  apiSentryEnabled = environment !== 'development' && Boolean(dsn);

  Sentry.init({
    dsn,
    enabled: apiSentryEnabled,
    environment,
    release: resolveApiSentryRelease(),
    serverName: 'api',
    debug: false,
    maxValueLength: 8_192,
    sendDefaultPii: true,
    initialScope: {
      tags: {
        'roomote.service': 'api',
      },
    },
  });

  apiSentryInitialized = true;

  return apiSentryEnabled;
}

export function captureApiException(
  error: unknown,
  c?: Context<{ Variables: Variables }>,
  context?: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!apiSentryInitialized) {
    initApiSentry();
  }

  if (!apiSentryEnabled) {
    return;
  }

  Sentry.withScope((scope: Scope) => {
    scope.setLevel('error');

    if (c) {
      setRequestScope(scope, c);
    }

    if (context) {
      scope.setContext('api', context);
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

export async function flushApiSentry(timeoutMs = MAX_SENTRY_FLUSH_MS) {
  if (!apiSentryInitialized) {
    return true;
  }

  return Sentry.flush(timeoutMs);
}
