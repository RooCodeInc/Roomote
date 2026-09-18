function collectErrorStrings(error: unknown, values: Set<string>): void {
  if (!error) {
    return;
  }

  if (typeof error === 'string') {
    values.add(error);
    return;
  }

  if (!(error instanceof Error)) {
    try {
      values.add(JSON.stringify(error));
    } catch {
      values.add(String(error));
    }
    return;
  }

  values.add(error.name);
  values.add(error.message);

  const errorWithCode = error as Error & { code?: unknown };
  if (typeof errorWithCode.code === 'string') {
    values.add(errorWithCode.code);
  }

  collectErrorStrings(error.cause, values);
}

export function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const parts = new Set<string>();
    collectErrorStrings(error, parts);
    return Array.from(parts)
      .filter((part) => part && part !== 'Error')
      .join(' | ');
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function formatLogFieldValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  if (value instanceof Error) {
    return JSON.stringify(formatErrorForLog(value));
  }

  try {
    const serialized = JSON.stringify(value);

    if (typeof serialized === 'string') {
      return serialized;
    }
  } catch {
    // Fall through to a string coercion fallback below.
  }

  return JSON.stringify(String(value));
}

export function formatLogFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .flatMap(([key, value]) =>
      typeof value === 'undefined'
        ? []
        : [`${key}=${formatLogFieldValue(value)}`],
    )
    .join(' ');
}

export function formatSingleLineLog(
  message: string,
  fields?: Record<string, unknown>,
): string {
  const suffix = fields ? formatLogFields(fields) : '';
  return suffix ? `${message} ${suffix}` : message;
}

const OPERATIONAL_LOG_FIELD_NAMES = [
  'service',
  'environment',
  'release',
  'projectId',
  'deploymentId',
  'serviceId',
  'instanceId',
  'provider',
  'surface',
  'eventType',
  'outcome',
  'reason',
  'status',
  'requestId',
  'deliveryId',
  'externalEventId',
  'updateId',
  'repository',
  'prNumber',
  'reviewId',
  'workspaceId',
  'channelId',
  'threadId',
  'messageId',
  'sessionId',
  'taskId',
  'runId',
  'jobId',
  'routeProvider',
  'durationMs',
  'attempt',
  'deferrals',
  'eventCount',
  'taskCount',
  'retryable',
] as const;

type OperationalLogFieldName = (typeof OPERATIONAL_LOG_FIELD_NAMES)[number];
type OperationalLogFieldValue = string | number | boolean | null | undefined;

export type OperationalLogFields = Partial<
  Record<OperationalLogFieldName, OperationalLogFieldValue>
>;

const operationalLogFieldNames = new Set<string>(OPERATIONAL_LOG_FIELD_NAMES);

function normalizeOperationalLogValue(
  value: OperationalLogFieldValue,
): Exclude<OperationalLogFieldValue, undefined> | undefined {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, 256) : undefined;
}

/**
 * Formats a query-friendly operational event using only explicitly safe fields.
 * Arbitrary metadata is intentionally dropped so payloads, bodies, URLs, and
 * credentials cannot be added to lifecycle logs by accident.
 */
export function formatOperationalEvent(
  event: string,
  fields: OperationalLogFields,
): string {
  const output: Record<string, string | number | boolean | null> = {
    event: normalizeOperationalLogValue(event) ?? 'unknown',
  };

  for (const [key, rawValue] of Object.entries(fields)) {
    if (!operationalLogFieldNames.has(key)) {
      continue;
    }

    const value = normalizeOperationalLogValue(rawValue);
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return JSON.stringify(output);
}

export function getOperationalLogRuntimeFields(
  service: string,
  env: Record<string, string | undefined>,
): OperationalLogFields {
  return {
    service,
    environment: env.R_APP_ENV?.trim() || env.NODE_ENV?.trim(),
    release: env.RELEASE_VERSION?.trim(),
    projectId: env.RAILWAY_PROJECT_ID?.trim(),
    deploymentId: env.RAILWAY_DEPLOYMENT_ID?.trim(),
    serviceId: env.RAILWAY_SERVICE_ID?.trim(),
    instanceId: env.R_INSTANCE_ID?.trim(),
  };
}

export type SandboxLogFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, unknown>,
) => void;

export const defaultConsoleLogger: SandboxLogFn = (
  level,
  message,
  metadata,
) => {
  const writer =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;

  if (metadata) {
    writer(message, metadata);
  } else {
    writer(message);
  }
};
