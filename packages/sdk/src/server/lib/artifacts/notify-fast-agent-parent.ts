import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';

import { enqueueFastAgentParentEvent } from '../fast-agent-parent-event-queue';

export type FastArtifactNotificationResult =
  | 'not_applicable'
  | 'in_progress'
  | 'queued'
  | 'failed';

const LEGACY_ARTIFACT_DELIVERY_LEASE_MS = 15 * 60 * 1000;

function getLegacyArtifactDeliveryState(
  marker: unknown,
): 'in_progress' | 'settled' | null {
  if (marker === null || marker === undefined) return null;
  if (typeof marker !== 'string' || !marker.startsWith('delivering:')) {
    return 'settled';
  }

  const claimedAt = Number(marker.slice('delivering:'.length));
  return Number.isFinite(claimedAt) &&
    claimedAt >= Date.now() - LEGACY_ARTIFACT_DELIVERY_LEASE_MS
    ? 'in_progress'
    : null;
}

function buildArtifactViewUrl(input: {
  taskId: string;
  path: string;
  version: number;
}): string {
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
  const encodedPath = input.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl}/task/${encodeURIComponent(input.taskId)}/artifacts/${encodedPath}?v=${input.version}`;
}

/** Give one uploaded artifact version to its runless Fast orchestrator. */
export async function notifyFastAgentParentOnArtifact(input: {
  id: string;
  taskId: string;
  runId: number | null;
  path: string;
  version: number;
  contentType: string;
  uploaded: boolean;
}): Promise<FastArtifactNotificationResult> {
  if (!input.runId || !input.uploaded) {
    return 'not_applicable';
  }

  const run = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)),
    columns: { id: true, taskId: true, payload: true, result: true },
  });
  const parent = getFastAgentParentFromPayload(run?.payload);
  if (!run || !parent) {
    return 'not_applicable';
  }

  // N-1 compatibility: a previous release recorded presentation claims on the
  // run. Honor settled and live markers without creating new dual claims; stale
  // claims fall through to the durable queue's event-key idempotency.
  const legacyDeliveryState = getLegacyArtifactDeliveryState(
    (run.result as Record<string, unknown> | null)?.[
      `fastAgentArtifact:${input.id}`
    ],
  );
  if (legacyDeliveryState === 'settled') return 'queued';
  if (legacyDeliveryState === 'in_progress') return 'in_progress';

  try {
    await enqueueFastAgentParentEvent({
      parent,
      event: {
        type: 'artifact_published',
        taskId: input.taskId,
        runId: run.id,
        artifact: {
          id: input.id,
          path: input.path,
          version: input.version,
          contentType: input.contentType,
          viewUrl: buildArtifactViewUrl(input),
        },
      },
    });

    try {
      await recordTaskRunLifecycleEvent(db, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Queued artifact ${input.id} version ${input.version} for the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_artifact_event',
          artifactId: input.id,
          artifactPath: input.path,
          artifactVersion: input.version,
          fastAgentSessionId: parent.sessionId,
        },
      });
    } catch (error) {
      console.error(
        `[notifyFastAgentParentOnArtifact] Failed to record queue admission for artifact ${input.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return 'queued';
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnArtifact] Failed for artifact ${input.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
}
