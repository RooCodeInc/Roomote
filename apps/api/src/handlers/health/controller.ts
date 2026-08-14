import { Hono } from 'hono';

import { Env } from '@roomote/env';
import {
  STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES,
  STUCK_IN_QUEUE_THRESHOLD_MINUTES,
  STUCK_RUN_HEALTH_MAX_AGE_MINUTES,
} from '@roomote/types';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import {
  db,
  sql,
  taskRuns,
  isNull,
  isNotNull,
  and,
  lt,
} from '@roomote/db/server';
import {
  logHealthCheckDiagnostics,
  runTimedHealthCheck,
  toHealthCheckLogEntry,
  type HealthCheckSummary,
} from './diagnostics';
import type { Variables } from '../../types';
import { buildHealthResponse } from './response';

export const controllerHealth = new Hono<{ Variables: Variables }>();

const CONTROLLER_STALE_THRESHOLD_SECONDS = 300;

type CheckResult =
  | { ok: true; summary?: HealthCheckSummary }
  | { ok: false; error: string; summary?: HealthCheckSummary };

/**
 * Splits stuck rows into a recent set (fails health: fresh stuckness means an
 * active incident) and an ancient set (reported in the summary only: rows
 * older than STUCK_RUN_HEALTH_MAX_AGE_MINUTES are debris from a past
 * incident, and failing health on them forever blocks every fleet rollout).
 */
function partitionStuckRunsByAge<T extends { stuckSince: Date }>(
  stuckRuns: T[],
): { recent: T[]; ancient: T[] } {
  const maxAgeCutoffMs = Date.now() - STUCK_RUN_HEALTH_MAX_AGE_MINUTES * 60_000;

  return {
    recent: stuckRuns.filter(
      (run) => run.stuckSince.getTime() >= maxAgeCutoffMs,
    ),
    ancient: stuckRuns.filter(
      (run) => run.stuckSince.getTime() < maxAgeCutoffMs,
    ),
  };
}

async function checkStuckInQueue(): Promise<CheckResult> {
  try {
    const thresholdTime = sql`NOW() - INTERVAL '${sql.raw(String(STUCK_IN_QUEUE_THRESHOLD_MINUTES))} minutes'`;

    const stuckRuns = await db
      .select({ id: taskRuns.id, stuckSince: taskRuns.createdAt })
      .from(taskRuns)
      .where(
        and(
          isNull(taskRuns.dequeuedAt),
          isNull(taskRuns.canceledAt),
          isNull(taskRuns.completedAt),
          lt(taskRuns.createdAt, thresholdTime),
        ),
      );

    const { recent, ancient } = partitionStuckRunsByAge(stuckRuns);

    if (recent.length > 0) {
      const ids = recent.map((job) => job.id).join(', ');

      return {
        ok: false,
        error: `Jobs stuck in queue (not dequeued within ${STUCK_IN_QUEUE_THRESHOLD_MINUTES} min): [${ids}]`,
        summary: {
          stuckInQueueCount: recent.length,
          ancientStuckInQueueCount: ancient.length,
        },
      };
    }

    return {
      ok: true,
      summary: {
        stuckInQueueCount: 0,
        ancientStuckInQueueCount: ancient.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Stuck in queue check failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: {
        stuckInQueueCount: null,
      },
    };
  }
}

async function checkStuckAfterDequeue(): Promise<CheckResult> {
  try {
    const thresholdTime = sql`NOW() - INTERVAL '${sql.raw(String(STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES))} minutes'`;

    const stuckRuns = await db
      .select({ id: taskRuns.id, stuckSince: taskRuns.dequeuedAt })
      .from(taskRuns)
      .where(
        and(
          isNotNull(taskRuns.dequeuedAt),
          isNull(taskRuns.startedAt),
          isNull(taskRuns.canceledAt),
          isNull(taskRuns.completedAt),
          lt(taskRuns.dequeuedAt, thresholdTime),
        ),
      );

    const { recent, ancient } = partitionStuckRunsByAge(
      // The WHERE clause requires dequeuedAt to be set; assert it for the
      // shared partition helper.
      stuckRuns.map((run) => ({ ...run, stuckSince: run.stuckSince! })),
    );

    if (recent.length > 0) {
      const ids = recent.map((job) => job.id).join(', ');

      return {
        ok: false,
        error: `Jobs stuck after dequeue (not started within ${STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES} min): [${ids}]`,
        summary: {
          stuckAfterDequeueCount: recent.length,
          ancientStuckAfterDequeueCount: ancient.length,
        },
      };
    }

    return {
      ok: true,
      summary: {
        stuckAfterDequeueCount: 0,
        ancientStuckAfterDequeueCount: ancient.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Stuck after dequeue check failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: {
        stuckAfterDequeueCount: null,
      },
    };
  }
}

async function checkController(): Promise<CheckResult> {
  try {
    const lastHeartbeat = await getRedis().get(REDIS_KEYS.CONTROLLER_HEARTBEAT);

    if (!lastHeartbeat) {
      return {
        ok: false,
        error: 'Controller heartbeat not found in Redis',
        summary: {
          controllerHeartbeatAgeMs: null,
        },
      };
    }

    const lastHeartbeatTime = parseInt(lastHeartbeat, 10);
    const elapsedSeconds = (Date.now() - lastHeartbeatTime) / 1000;
    const controllerHeartbeatAgeMs = Math.round(elapsedSeconds * 1000);

    if (elapsedSeconds > CONTROLLER_STALE_THRESHOLD_SECONDS) {
      return {
        ok: false,
        error: `Controller stale: last heartbeat ${elapsedSeconds.toFixed(1)}s ago (threshold: ${CONTROLLER_STALE_THRESHOLD_SECONDS}s)`,
        summary: {
          controllerHeartbeatAgeMs,
        },
      };
    }

    return {
      ok: true,
      summary: {
        controllerHeartbeatAgeMs,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Controller check failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: {
        controllerHeartbeatAgeMs: null,
      },
    };
  }
}

controllerHealth.get('/', async (c) => {
  const requestStartedAt = Date.now();
  const slowThresholdMs = Env.API_SLOW_REQUEST_THRESHOLD_MS;

  const checks = await Promise.all([
    runTimedHealthCheck('controllerHeartbeat', checkController),
    runTimedHealthCheck('stuckInQueue', checkStuckInQueue),
    runTimedHealthCheck('stuckAfterDequeue', checkStuckAfterDequeue),
  ]);

  const errors: string[] = [];
  const failingChecks: string[] = [];

  for (const { name, value: result } of checks) {
    if (!result.ok) {
      errors.push(result.error);
      failingChecks.push(name);
    }
  }

  const isHealthy = errors.length === 0;

  logHealthCheckDiagnostics({
    route: c.req.path,
    totalDurationMs: Date.now() - requestStartedAt,
    slowThresholdMs,
    checks: checks.map((check) =>
      toHealthCheckLogEntry({
        check,
        ok: check.value.ok,
        error: check.value.ok ? undefined : check.value.error,
        summary: check.value.summary,
      }),
    ),
  });

  return c.json(
    buildHealthResponse(
      c,
      {
        server: 'controller',
        ok: isHealthy,
        timestamp: new Date().toISOString(),
        // Check names only — visible without auth so an unhealthy 503 is
        // diagnosable from the response body (fleet rollout health gates
        // surface this body, not the api's [Health Check] log lines). Run
        // ids and error detail stay in the auth-gated `error` field.
        ...(failingChecks.length > 0 ? { failingChecks } : {}),
      },
      {
        environment: { NODE_ENV: Env.NODE_ENV, APP_ENV: Env.APP_ENV },
        error: errors.length > 0 ? errors.join('; ') : undefined,
      },
    ),
    { status: isHealthy ? 200 : 503 },
  );
});
