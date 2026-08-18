import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';

import { deliverFastAgentParentEvent } from '../fast-agent-parent-event';
import { isFastAgentDeliveringMarker } from '../task-runs/fast-agent-delivery-claim';
import { runFastAgentParentEventLifecycle } from '../task-runs/fast-agent-parent-event-lifecycle';

export type FastArtifactNotificationResult =
  | 'not_applicable'
  | 'already_delivered'
  | 'in_progress'
  | 'delivered'
  | 'skipped'
  | 'failed';

/** Fail the turn-lock wait well below the worker's request timeout so the
 * caller can 503 and the worker's confirmUpload retry does the waiting. */
const ARTIFACT_DELIVERY_LOCK_WAIT_MS = 30_000;

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

  const deliveryKey = `fastAgentArtifact:${input.id}`;
  const result = await runFastAgentParentEventLifecycle({
    runId: run.id,
    deliveryKey,
    deliveredMarker: 'delivered',
    permanentFailureMarker: 'skipped',
    deliver: () =>
      deliverFastAgentParentEvent({
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
        lockWaitMs: ARTIFACT_DELIVERY_LOCK_WAIT_MS,
      }),
    recordDelivered: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Passed artifact ${input.id} version ${input.version} to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_artifact_event',
          artifactId: input.id,
          artifactPath: input.path,
          artifactVersion: input.version,
          fastAgentSessionId: parent.sessionId,
        },
      }),
  });

  if (result.status === 'not_claimed') {
    // Distinguish a live in-flight delivery (the caller should keep
    // retrying) from a settled one (the caller must stop).
    const current = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
      columns: { result: true },
    });
    const marker = (current?.result as Record<string, unknown> | null)?.[
      deliveryKey
    ];
    return isFastAgentDeliveringMarker(marker)
      ? 'in_progress'
      : 'already_delivered';
  }
  if (result.status === 'failed') {
    const error = result.error;
    console.error(
      `[notifyFastAgentParentOnArtifact] Failed for artifact ${input.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
  return result.status;
}
