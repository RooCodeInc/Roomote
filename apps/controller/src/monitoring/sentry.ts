import * as Sentry from '@sentry/node';
import type { Scope } from '@sentry/node';
import { resolveModalRpcErrorEnrichment } from '@roomote/compute-providers';

const CONTROLLER_SENTRY_DSN_KEYS = [
  'CONTROLLER_SENTRY_DSN',
  'SENTRY_DSN',
] as const;
const MAX_SENTRY_FLUSH_MS = 2_000;
const CONTROLLER_SENTRY_STATE_KEY = '__roomoteControllerSentryState__' as const;

type ControllerSentryScope = Pick<
  Scope,
  'setContext' | 'setFingerprint' | 'setLevel' | 'setTag'
>;
type ControllerSentryLevel = NonNullable<Parameters<Scope['setLevel']>[0]>;
type ControllerSentryContext = Record<
  string,
  string | number | boolean | null | undefined
>;

interface ControllerMessageOptions {
  component?: string;
  level?: ControllerSentryLevel;
  signal?: string;
}

interface ControllerSentryState {
  enabled: boolean;
  initialized: boolean;
}

type ControllerSentryGlobal = typeof globalThis & {
  [CONTROLLER_SENTRY_STATE_KEY]?: ControllerSentryState;
};

function getControllerSentryState(): ControllerSentryState {
  const globalState = globalThis as ControllerSentryGlobal;

  globalState[CONTROLLER_SENTRY_STATE_KEY] ??= {
    enabled: false,
    initialized: false,
  };

  return globalState[CONTROLLER_SENTRY_STATE_KEY];
}

function resolveControllerSentryDsn(): string | undefined {
  for (const key of CONTROLLER_SENTRY_DSN_KEYS) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function resolveControllerSentryEnvironment(): string | undefined {
  return (
    process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim() || undefined
  );
}

function resolveControllerSentryRelease(): string | undefined {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.RELEASE_VERSION?.trim() ||
    undefined
  );
}

function readControllerContextString(
  context: ControllerSentryContext | undefined,
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

function applyControllerContextToScope(
  scope: ControllerSentryScope,
  context?: ControllerSentryContext,
): ControllerSentryContext | undefined {
  if (!context) {
    return undefined;
  }

  scope.setContext('controller', context);

  const provider = readControllerContextString(context, 'provider');

  if (provider) {
    scope.setTag('roomote.provider', provider);
  }

  const phase = readControllerContextString(context, 'phase');

  if (phase) {
    scope.setTag('roomote.phase', phase);
  }

  return context;
}

function applySentryTags(
  scope: ControllerSentryScope,
  tags: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(tags)) {
    scope.setTag(key, value);
  }
}

export function initControllerSentry(): boolean {
  const state = getControllerSentryState();

  if (state.initialized) {
    return state.enabled;
  }

  const dsn = resolveControllerSentryDsn();
  const environment = resolveControllerSentryEnvironment();
  state.enabled = environment !== 'development' && Boolean(dsn);

  Sentry.init({
    dsn,
    enabled: state.enabled,
    environment,
    release: resolveControllerSentryRelease(),
    serverName: 'controller',
    debug: false,
    maxValueLength: 8_192,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        'roomote.service': 'controller',
      },
    },
  });

  state.initialized = true;

  return state.enabled;
}

export function captureControllerException(
  error: unknown,
  context?: ControllerSentryContext,
): void {
  const state = getControllerSentryState();

  if (!state.initialized) {
    initControllerSentry();
  }

  if (!state.enabled) {
    return;
  }

  Sentry.withScope((scope: ControllerSentryScope) => {
    scope.setLevel('error');
    scope.setTag('roomote.signal', 'controller-exception');
    const mergedContext = applyControllerContextToScope(scope, context);
    const modalEnrichment =
      readControllerContextString(mergedContext, 'provider') === 'modal'
        ? resolveModalRpcErrorEnrichment(error, {
            fingerprintPrefix: ['roomote-controller-exception'],
            phase: readControllerContextString(mergedContext, 'phase'),
          })
        : undefined;

    if (modalEnrichment) {
      applySentryTags(scope, modalEnrichment.tags);
      scope.setFingerprint(modalEnrichment.fingerprint);
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

export function captureControllerMessage(
  message: string,
  context?: ControllerSentryContext,
  options?: ControllerMessageOptions,
): void {
  const state = getControllerSentryState();

  if (!state.initialized) {
    initControllerSentry();
  }

  if (!state.enabled) {
    return;
  }

  Sentry.withScope((scope: ControllerSentryScope) => {
    const level = options?.level ?? 'error';

    scope.setLevel(level);
    scope.setTag('roomote.signal', options?.signal ?? 'controller-message');

    if (options?.component) {
      scope.setTag('roomote.component', options.component);
    }

    applyControllerContextToScope(scope, context);

    Sentry.captureMessage(message, level);
  });
}

export async function flushControllerSentry(
  timeoutMs = MAX_SENTRY_FLUSH_MS,
): Promise<boolean> {
  if (!getControllerSentryState().initialized) {
    return true;
  }

  return Sentry.flush(timeoutMs);
}
