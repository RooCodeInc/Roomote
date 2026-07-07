import * as Sentry from '@sentry/node';
import type { Scope } from '@sentry/node';

const BULLMQ_SENTRY_DSN_KEYS = ['BULLMQ_SENTRY_DSN', 'SENTRY_DSN'] as const;

interface BullMqSentryContext {
  [key: string]: unknown;
  cloudJobId?: number | string;
  cloudJobStatus?: string | null;
  computeProvider?: string;
  error?: string;
  errorName?: string | null;
  postFailureInstanceStatus?: string | null;
  preSnapshotInstanceStatus?: string | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  providerRequestId?: string | null;
  providerResponseStatus?: number | null;
  providerResponseStatusText?: string | null;
  queueAttempt?: number;
  queueJobId?: string | null;
  rootCauseSummary?: string | null;
  sandboxId?: string;
  snapshotIntentId?: string | null;
  snapshotStage?: string;
  taskId?: string;
  taskPhase?: string | null;
  triggerPath?: string | null;
}

interface BullMqMessageOptions {
  component?: string;
  level?: 'warning' | 'error';
  signal?: string;
}

type BullMqSentryScope = Pick<Scope, 'setContext' | 'setLevel' | 'setTag'>;

const BULLMQ_CONTEXT_TAGS = {
  cloudJobId: 'roomote.cloud_job_id',
  computeProvider: 'roomote.compute_provider',
  providerErrorCode: 'roomote.provider_error_code',
  providerRequestId: 'roomote.provider_request_id',
  providerResponseStatus: 'roomote.provider_response_status',
  queueJobId: 'roomote.queue_job_id',
  sandboxId: 'roomote.sandbox_id',
  snapshotIntentId: 'roomote.snapshot_intent_id',
  snapshotStage: 'roomote.snapshot_stage',
  taskId: 'roomote.task_id',
  taskPhase: 'roomote.task_phase',
  triggerPath: 'roomote.trigger_path',
} as const satisfies Partial<Record<keyof BullMqSentryContext, string>>;

let bullMqSentryInitialized = false;
let bullMqSentryEnabled = false;

function resolveBullMqSentryDsn(): string | undefined {
  for (const key of BULLMQ_SENTRY_DSN_KEYS) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function resolveBullMqSentryEnvironment(): string | undefined {
  return (
    process.env.ROOMOTE_APP_ENV?.trim() ||
    process.env.APP_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    'development'
  );
}

function resolveBullMqSentryRelease(): string | undefined {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.RELEASE_VERSION?.trim() ||
    undefined
  );
}

function applyBullMqContextToScope(
  scope: BullMqSentryScope,
  context?: BullMqSentryContext,
): void {
  if (!context) {
    return;
  }

  scope.setContext('bullmq', context);

  for (const [contextKey, tagKey] of Object.entries(BULLMQ_CONTEXT_TAGS) as [
    keyof typeof BULLMQ_CONTEXT_TAGS,
    string,
  ][]) {
    const value = context[contextKey];

    if (typeof value === 'string' && value.length > 0) {
      scope.setTag(tagKey, value);
      continue;
    }

    if (typeof value === 'number') {
      scope.setTag(tagKey, String(value));
    }
  }
}

export function initBullMqSentry(): boolean {
  if (bullMqSentryInitialized) {
    return bullMqSentryEnabled;
  }

  const dsn = resolveBullMqSentryDsn();
  const environment = resolveBullMqSentryEnvironment();
  bullMqSentryEnabled = environment !== 'development' && Boolean(dsn);

  Sentry.init({
    dsn,
    enabled: bullMqSentryEnabled,
    environment,
    release: resolveBullMqSentryRelease(),
    serverName: 'bullmq',
    debug: false,
    maxValueLength: 8_192,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        'roomote.service': 'bullmq',
      },
    },
  });

  bullMqSentryInitialized = true;

  return bullMqSentryEnabled;
}

export function captureBullMqMessage(
  message: string,
  context?: BullMqSentryContext,
  options?: BullMqMessageOptions,
): void {
  if (!bullMqSentryInitialized) {
    initBullMqSentry();
  }

  if (!bullMqSentryEnabled) {
    return;
  }

  Sentry.withScope((scope: BullMqSentryScope) => {
    const level = options?.level ?? 'error';
    scope.setLevel(level);
    scope.setTag('roomote.signal', options?.signal ?? 'bullmq-message');

    if (options?.component) {
      scope.setTag('roomote.component', options.component);
    }

    applyBullMqContextToScope(scope, context);

    Sentry.captureMessage(message, level);
  });
}
