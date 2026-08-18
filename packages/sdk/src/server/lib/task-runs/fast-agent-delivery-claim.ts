import { randomUUID } from 'node:crypto';

import { type SQL, sql, taskRuns } from '@roomote/db/server';

/** How long a 'delivering:<epochMs>' claim stays exclusive. Long enough for a
 * full turn-lock wait plus an orchestrator turn; after this a crashed
 * delivery's claim can be stolen by a retry instead of stranding the event. */
const FAST_AGENT_DELIVERY_LEASE_MS = 15 * 60 * 1000;

export function buildFastAgentDeliveringMarker(): string {
  return `delivering:${Date.now()}:${randomUUID()}`;
}

export function isFastAgentDeliveringMarker(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('delivering:');
}

/**
 * Claim predicate for a jsonb delivery key on task_runs.result: the key is
 * unclaimed, or holds a 'delivering:<epochMs>' lease older than the lease
 * window (a crashed delivery whose claim may be stolen). Terminal markers
 * ('delivered', a timestamp, 'skipped') never match, so a settled delivery is
 * never repeated.
 */
export function buildFastAgentDeliveryClaimPredicate(deliveryKey: string): SQL {
  const staleBefore = Date.now() - FAST_AGENT_DELIVERY_LEASE_MS;
  return sql`(
    (${taskRuns.result} -> ${deliveryKey}) is null
    or (
      case
        when (${taskRuns.result} ->> ${deliveryKey}) like 'delivering:%'
          and split_part(${taskRuns.result} ->> ${deliveryKey}, ':', 2) ~ '^[0-9]+$'
        then (split_part(${taskRuns.result} ->> ${deliveryKey}, ':', 2))::bigint
        else null
      end
    ) < ${staleBefore}
  )`;
}
