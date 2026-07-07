type HealthCheckSummaryValue = string | number | boolean | null;

export type HealthCheckSummary = Record<string, HealthCheckSummaryValue>;

type TimedHealthCheckResult<T> = {
  name: string;
  durationMs: number;
  value: T;
};

type HealthCheckLogEntry = {
  name: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  summary?: HealthCheckSummary;
};

function formatHealthCheckError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function formatHealthCheckResponseError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function runTimedHealthCheck<T>(
  name: string,
  check: () => Promise<T>,
): Promise<TimedHealthCheckResult<T>> {
  const startedAt = Date.now();
  const value = await check();

  return {
    name,
    durationMs: Date.now() - startedAt,
    value,
  };
}

export function logHealthCheckDiagnostics(input: {
  route: string;
  totalDurationMs: number;
  slowThresholdMs: number;
  checks: HealthCheckLogEntry[];
}): void {
  const unhealthy = input.checks.some((check) => !check.ok);
  const slow = input.totalDurationMs >= input.slowThresholdMs;

  if (!unhealthy && !slow) {
    return;
  }

  const payload = {
    route: input.route,
    status: unhealthy ? 'unhealthy' : 'slow',
    totalDurationMs: input.totalDurationMs,
    slowThresholdMs: input.slowThresholdMs,
    checks: input.checks,
  };

  const logMessage = `[Health Check] ${JSON.stringify(payload)}`;

  if (unhealthy) {
    console.error(logMessage);
    return;
  }

  console.warn(logMessage);
}

export function toHealthCheckLogEntry<T>(input: {
  check: TimedHealthCheckResult<T>;
  ok: boolean;
  error?: string | null;
  summary?: HealthCheckSummary;
}): HealthCheckLogEntry {
  return {
    name: input.check.name,
    durationMs: input.check.durationMs,
    ok: input.ok,
    error: input.error ?? undefined,
    summary: input.summary,
  };
}

export function getHealthCheckErrorMessage(error: unknown): string {
  return formatHealthCheckError(error);
}

export function getHealthCheckResponseErrorMessage(error: unknown): string {
  return formatHealthCheckResponseError(error);
}
