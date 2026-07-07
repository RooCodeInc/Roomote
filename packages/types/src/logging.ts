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
