import { inspect } from 'node:util';

import * as Sentry from '@sentry/node';
import { WORKER_CONTEXT_ENV_VARS } from '@roomote/types';

import {
  getWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from './runtime-context';
import { resolveWorkerReleaseMetadata } from './worker-release-metadata';

const WORKER_SENTRY_DSN_KEYS = ['WORKER_SENTRY_DSN', 'SENTRY_DSN'] as const;
const MAX_SENTRY_FLUSH_MS = 2_000;
const WORKER_SENTRY_DISABLED_INTEGRATIONS = new Set([
  'OnUncaughtException',
  'OnUnhandledRejection',
]);
const AUTH_PROXY_LOOPBACK_ERROR_STAGES = new Set([
  'authProxy.proxy.error',
  'multiplexAuthProxy.proxy.error',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);

let workerSentryInitialized = false;
let workerSentryEnabled = false;

type WorkerSentryContext = WorkerRuntimeContext;

interface WorkerMessageOptions {
  component?: string;
  level?: 'warning' | 'error';
  signal?: string;
  tags?: Record<string, string | null | undefined>;
}

interface WorkerFatalProcessHandlerOptions {
  isIgnorableError?: (error: unknown) => boolean;
  logger?: Pick<Console, 'warn' | 'error'>;
  uncaughtExceptionStage: string;
  unhandledRejectionStage: string;
  exit?: (code: number) => void;
}

interface WorkerSentryScopeLike {
  setContext(name: string, context: WorkerSentryContext): void;
  setFingerprint(fingerprint: string[]): void;
  setTag(key: string, value: string): void;
}

interface NodeConnectionError extends Error {
  address?: string;
  code?: string;
}

function isTrpcClientError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TRPCClientError';
}

function readWorkerContextString(
  context: WorkerSentryContext | undefined,
  key: string,
): string | undefined {
  const value = context?.[key];

  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

function normalizeLoopbackHost(host: string): string | undefined {
  const normalized = host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

  return LOOPBACK_HOSTS.has(normalized) ? normalized : undefined;
}

function extractLoopbackHostFromError(error: Error): string | undefined {
  const nodeError = error as NodeConnectionError;
  const address =
    typeof nodeError.address === 'string'
      ? normalizeLoopbackHost(nodeError.address)
      : undefined;

  if (address) {
    return address;
  }

  const match = error.message.match(
    /(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?/i,
  );

  if (!match) {
    return undefined;
  }

  const matchedHost = match[1];

  return matchedHost ? normalizeLoopbackHost(matchedHost) : undefined;
}

function resolveAuthProxyLoopbackConnectionRefusedFingerprint(
  error: unknown,
  context: WorkerSentryContext | undefined,
): string[] | undefined {
  const stage = readWorkerContextString(context, 'stage');

  if (!stage || !AUTH_PROXY_LOOPBACK_ERROR_STAGES.has(stage)) {
    return undefined;
  }

  if (!(error instanceof Error)) {
    return undefined;
  }

  const nodeError = error as NodeConnectionError;
  const errorCode =
    typeof nodeError.code === 'string'
      ? nodeError.code.toUpperCase()
      : undefined;
  const errorMessage = error.message.toUpperCase();

  if (errorCode !== 'ECONNREFUSED' && !errorMessage.includes('ECONNREFUSED')) {
    return undefined;
  }

  if (!extractLoopbackHostFromError(error)) {
    return undefined;
  }

  const fingerprint = [
    'roomote-worker-loopback-connection-refused',
    'auth-proxy',
  ];
  const environment = resolveWorkerSentryEnvironment();

  if (environment) {
    fingerprint.push(environment);
  }

  return fingerprint;
}

function resolveWorkerExceptionFingerprint(
  context: WorkerSentryContext | undefined,
): string[] | undefined {
  const taskId = readWorkerContextString(context, 'taskId');

  if (taskId) {
    return ['roomote-worker-exception', 'taskId', taskId];
  }

  const cloudJobId = readWorkerContextString(context, 'cloudJobId');

  if (cloudJobId) {
    return ['roomote-worker-exception', 'cloudJobId', cloudJobId];
  }

  const environmentId = readWorkerContextString(context, 'environmentId');

  if (environmentId) {
    return ['roomote-worker-exception', 'environmentId', environmentId];
  }

  const stage = readWorkerContextString(context, 'stage');

  if (stage) {
    return ['roomote-worker-exception', 'stage', stage];
  }

  return undefined;
}

function resolveTrpcClientErrorFingerprint(
  error: Error,
  context: WorkerSentryContext | undefined,
): string[] {
  const fingerprint = ['trpc-client-error', error.message];
  const environment = resolveWorkerSentryEnvironment();

  if (environment) {
    fingerprint.push(environment);
  }

  const computeProvider = readWorkerContextString(context, 'computeProvider');

  if (computeProvider) {
    fingerprint.push(computeProvider);
  }

  return fingerprint;
}

function readOptionalEnvValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function resolveWorkerSentryDsn(): string | undefined {
  for (const key of WORKER_SENTRY_DSN_KEYS) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function resolveWorkerSentryEnvironment(): string | undefined {
  return (
    process.env.ROOMOTE_APP_ENV?.trim() ||
    process.env.APP_ENV?.trim() ||
    'development'
  );
}

function formatLogArgs(args: unknown[]): string[] {
  return args.map((arg) =>
    typeof arg === 'string'
      ? arg
      : inspect(arg, { depth: 5, breakLength: 120 }),
  );
}

function applyWorkerContextToScope(
  scope: WorkerSentryScopeLike,
  context?: WorkerSentryContext,
): WorkerSentryContext | undefined {
  const mergedContext = mergeWorkerContexts(
    resolveWorkerRuntimeContext(),
    getWorkerRuntimeContext(),
    context,
  );

  if (!mergedContext) {
    return undefined;
  }

  scope.setContext('worker', mergedContext);

  const taskId = mergedContext.taskId;

  if (typeof taskId === 'number' || typeof taskId === 'string') {
    scope.setTag('roomote.task_id', String(taskId));
  }

  const cloudJobId = mergedContext.cloudJobId;

  if (typeof cloudJobId === 'number' || typeof cloudJobId === 'string') {
    scope.setTag('roomote.cloud_job_id', String(cloudJobId));
  }

  const environmentId = mergedContext.environmentId;

  if (typeof environmentId === 'number' || typeof environmentId === 'string') {
    scope.setTag('roomote.environment_id', String(environmentId));
  }

  const computeProvider = mergedContext.computeProvider;

  if (typeof computeProvider === 'string' && computeProvider.length > 0) {
    scope.setTag('roomote.compute_provider', computeProvider);
  }

  return mergedContext;
}

const WORKER_CONTEXT_ENV_KEYS: Record<string, string> = {
  [WORKER_CONTEXT_ENV_VARS.deploymentSlug]: 'deploymentSlug',
  [WORKER_CONTEXT_ENV_VARS.environmentId]: 'environmentId',
  [WORKER_CONTEXT_ENV_VARS.computeProvider]: 'computeProvider',
  [WORKER_CONTEXT_ENV_VARS.computeProviderFingerprint]:
    'computeProviderFingerprint',
  [WORKER_CONTEXT_ENV_VARS.computeProviderFingerprintKind]:
    'computeProviderFingerprintKind',
};

function resolveWorkerRuntimeContext(): WorkerSentryContext | undefined {
  const context: WorkerSentryContext = {};

  for (const [envKey, ctxKey] of Object.entries(WORKER_CONTEXT_ENV_KEYS)) {
    const value = readOptionalEnvValue(envKey);
    if (value) {
      context[ctxKey] = value;
    }
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

function mergeWorkerContexts(
  ...sources: (WorkerSentryContext | undefined)[]
): WorkerSentryContext | undefined {
  const merged: WorkerSentryContext = {};

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function initWorkerSentry(): boolean {
  if (workerSentryInitialized) {
    return workerSentryEnabled;
  }

  const dsn = resolveWorkerSentryDsn();
  const environment = resolveWorkerSentryEnvironment();
  workerSentryEnabled = environment !== 'development' && Boolean(dsn);
  const workerReleaseMetadata = resolveWorkerReleaseMetadata();

  Sentry.init({
    dsn,
    enabled: workerSentryEnabled,
    environment,
    release: workerReleaseMetadata.sentryRelease,
    defaultIntegrations:
      Sentry.getDefaultIntegrationsWithoutPerformance().filter(
        (integration) =>
          !WORKER_SENTRY_DISABLED_INTEGRATIONS.has(integration.name),
      ),
    serverName: 'worker',
    debug: false,
    maxValueLength: 8_192,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        'roomote.service': 'worker',
        ...(workerReleaseMetadata.workerReleaseTag
          ? {
              'roomote.worker_release_tag':
                workerReleaseMetadata.workerReleaseTag,
            }
          : {}),
        ...(workerReleaseMetadata.workerVersion
          ? { 'roomote.worker_version': workerReleaseMetadata.workerVersion }
          : {}),
        ...(workerReleaseMetadata.workerCommit
          ? { 'roomote.worker_commit': workerReleaseMetadata.workerCommit }
          : {}),
      },
    },
  });

  workerSentryInitialized = true;

  return workerSentryEnabled;
}

export function captureWorkerException(
  error: unknown,
  context?: WorkerSentryContext,
): void {
  if (!workerSentryInitialized) {
    initWorkerSentry();
  }

  if (!workerSentryEnabled) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    scope.setTag('roomote.signal', 'worker-exception');

    const mergedContext = applyWorkerContextToScope(scope, context);
    const loopbackConnectionRefusedFingerprint =
      resolveAuthProxyLoopbackConnectionRefusedFingerprint(
        error,
        mergedContext,
      );

    if (loopbackConnectionRefusedFingerprint) {
      scope.setFingerprint(loopbackConnectionRefusedFingerprint);
    } else if (isTrpcClientError(error)) {
      scope.setFingerprint(
        resolveTrpcClientErrorFingerprint(error, mergedContext),
      );
    } else {
      const fingerprint = resolveWorkerExceptionFingerprint(mergedContext);

      if (fingerprint) {
        scope.setFingerprint(fingerprint);
      }
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

export function captureWorkerMessage(
  message: string,
  context?: WorkerSentryContext,
  options?: WorkerMessageOptions,
): void {
  if (!workerSentryInitialized) {
    initWorkerSentry();
  }

  if (!workerSentryEnabled) {
    return;
  }

  Sentry.withScope((scope) => {
    const level = options?.level ?? 'error';
    scope.setLevel(level);
    scope.setTag('roomote.signal', options?.signal ?? 'worker-message');

    if (options?.component) {
      scope.setTag('roomote.component', options.component);
    }

    for (const [key, value] of Object.entries(options?.tags ?? {})) {
      const normalizedValue = value?.trim();

      if (normalizedValue) {
        scope.setTag(key, normalizedValue);
      }
    }

    applyWorkerContextToScope(scope, context);

    Sentry.captureMessage(message, level);
  });
}

export function captureWorkerErrorLog(
  args: unknown[],
  context?: WorkerSentryContext,
): void {
  const errorArg = args.find((arg) => arg instanceof Error);

  if (errorArg instanceof Error) {
    captureWorkerException(errorArg, context);
    return;
  }

  const rendered = formatLogArgs(args).join(' ').trim();

  if (!rendered) {
    return;
  }

  captureWorkerMessage(rendered, context);
}

export function createWorkerFatalProcessHandlers({
  isIgnorableError,
  logger = console,
  uncaughtExceptionStage,
  unhandledRejectionStage,
  exit = defaultFatalExit,
}: WorkerFatalProcessHandlerOptions): {
  handleUncaughtException: (error: Error) => void;
  handleUnhandledRejection: (reason: unknown) => void;
} {
  return {
    handleUncaughtException: (error: Error) => {
      if (isIgnorableError?.(error)) {
        logger.warn(
          '[uncaughtException] Ignoring handled process error:',
          error.message,
        );
        return;
      }

      logger.error('[uncaughtException] Fatal:', error);
      captureWorkerException(error, { stage: uncaughtExceptionStage });
      exit(1);
    },
    handleUnhandledRejection: (reason: unknown) => {
      if (isIgnorableError?.(reason)) {
        logger.warn(
          '[unhandledRejection] Ignoring handled process error:',
          reason instanceof Error ? reason.message : String(reason),
        );
        return;
      }

      logger.error('[unhandledRejection] Fatal:', reason);
      captureWorkerException(reason, { stage: unhandledRejectionStage });
      exit(1);
    },
  };
}

export function installWorkerFatalProcessHandlers(
  options: WorkerFatalProcessHandlerOptions,
): void {
  const { handleUncaughtException, handleUnhandledRejection } =
    createWorkerFatalProcessHandlers(options);

  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
}

export async function flushWorkerSentry(timeoutMs = MAX_SENTRY_FLUSH_MS) {
  if (!workerSentryInitialized) {
    return true;
  }

  return Sentry.flush(timeoutMs);
}

function defaultFatalExit(code: number): void {
  void flushWorkerSentry().finally(() => {
    process.exit(code);
  });
}
