import { Hono } from 'hono';

import { Env } from '@roomote/env';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import { countOverdueQueuedFastAgentParentEvents } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import {
  logHealthCheckDiagnostics,
  runTimedHealthCheck,
  toHealthCheckLogEntry,
  type HealthCheckSummary,
} from './diagnostics';
import { buildHealthResponse } from './response';

export const bullmqHealth = new Hono<{ Variables: Variables }>();

/**
 * The scheduler heartbeat lands every minute. Five missed beats is well past
 * any Redis reconnect and matches the controller's staleness window.
 */
const BULLMQ_STALE_THRESHOLD_SECONDS = 300;

/**
 * Queued Session events (PR mentions joining a Session, child task messages,
 * settle notices) are drained only by the bullmq worker. One that has waited
 * this long is a user-visible silence, whatever the heartbeat says.
 */
const QUEUED_EVENT_OVERDUE_SECONDS = 300;

type CheckResult =
  | { ok: true; summary?: HealthCheckSummary }
  | { ok: false; error: string; summary?: HealthCheckSummary };

async function checkHeartbeat(): Promise<CheckResult> {
  try {
    const lastHeartbeat = await getRedis().get(REDIS_KEYS.BULLMQ_HEARTBEAT);

    if (!lastHeartbeat) {
      return {
        ok: false,
        error: 'bullmq heartbeat not found in Redis',
        summary: { bullmqHeartbeatAgeMs: null },
      };
    }

    const lastHeartbeatTime = Number(lastHeartbeat);

    if (!Number.isFinite(lastHeartbeatTime)) {
      return {
        ok: false,
        error: 'bullmq heartbeat in Redis is invalid',
        summary: { bullmqHeartbeatAgeMs: null },
      };
    }

    const elapsedSeconds = (Date.now() - lastHeartbeatTime) / 1000;
    const bullmqHeartbeatAgeMs = Math.round(elapsedSeconds * 1000);

    if (elapsedSeconds > BULLMQ_STALE_THRESHOLD_SECONDS) {
      return {
        ok: false,
        error: `bullmq stale: last heartbeat ${elapsedSeconds.toFixed(1)}s ago (threshold: ${BULLMQ_STALE_THRESHOLD_SECONDS}s)`,
        summary: { bullmqHeartbeatAgeMs },
      };
    }

    return { ok: true, summary: { bullmqHeartbeatAgeMs } };
  } catch (error) {
    return {
      ok: false,
      error: `bullmq heartbeat check failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: { bullmqHeartbeatAgeMs: null },
    };
  }
}

async function checkQueuedEvents(): Promise<CheckResult> {
  try {
    const overdueQueuedEventCount =
      await countOverdueQueuedFastAgentParentEvents(
        new Date(Date.now() - QUEUED_EVENT_OVERDUE_SECONDS * 1000),
      );

    if (overdueQueuedEventCount > 0) {
      return {
        ok: false,
        error: `${overdueQueuedEventCount} queued Session event(s) waited more than ${QUEUED_EVENT_OVERDUE_SECONDS}s for the bullmq worker`,
        summary: { overdueQueuedEventCount },
      };
    }

    return { ok: true, summary: { overdueQueuedEventCount: 0 } };
  } catch (error) {
    return {
      ok: false,
      error: `Queued event check failed: ${error instanceof Error ? error.message : String(error)}`,
      summary: { overdueQueuedEventCount: null },
    };
  }
}

/**
 * Liveness of the bullmq service as seen from its effects: the heartbeat its
 * scheduler worker writes and the backlog of queued Session events only it
 * can deliver. A bullmq process that is running but no longer processing jobs
 * passes every container-level check; this route is how a fleet probe or an
 * operator tells the difference.
 */
bullmqHealth.get('/', async (c) => {
  const requestStartedAt = Date.now();
  const slowThresholdMs = Env.API_SLOW_REQUEST_THRESHOLD_MS;

  const checks = await Promise.all([
    runTimedHealthCheck('bullmqHeartbeat', checkHeartbeat),
    runTimedHealthCheck('queuedEvents', checkQueuedEvents),
  ]);

  const errors: string[] = [];

  for (const { value: result } of checks) {
    if (!result.ok) {
      errors.push(result.error);
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
        server: 'bullmq',
        ok: isHealthy,
        timestamp: new Date().toISOString(),
      },
      {
        environment: { NODE_ENV: Env.NODE_ENV, APP_ENV: Env.APP_ENV },
        error: errors.length > 0 ? errors.join('; ') : undefined,
      },
    ),
    { status: isHealthy ? 200 : 503 },
  );
});
