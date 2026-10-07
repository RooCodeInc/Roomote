import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  taskArtifacts,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  normalizeFastAgentParentEvent,
  wakeFastAgentParentEventNow,
} from '../fast-agent-parent-event-queue';

export type FastArtifactNotificationResult =
  | 'not_applicable'
  | 'already_delivered'
  | 'queued'
  | 'skipped';

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

/** Publish and durably admit notification together; delivery never gates upload success. */
export async function notifyFastAgentParentOnArtifact(input: {
  id: string;
  taskId: string;
  runId: number | null;
  path: string;
  version: number;
  contentType: string;
  uploaded: boolean;
}): Promise<FastArtifactNotificationResult> {
  if (!input.uploaded) return 'not_applicable';
  const result = await db.transaction(async (tx) => {
    const [artifact] = await tx
      .update(taskArtifacts)
      .set({ uploaded: true, updatedAt: new Date() })
      .where(
        and(
          eq(taskArtifacts.id, input.id),
          eq(taskArtifacts.taskId, input.taskId),
        ),
      )
      .returning();
    if (!artifact) throw new Error('Artifact not found for publication.');
    if (!artifact.runId) return { notification: 'not_applicable' as const };
    const run = await tx.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.id, artifact.runId),
        eq(taskRuns.taskId, input.taskId),
      ),
      columns: { id: true, payload: true, result: true },
    });
    const parent = getFastAgentParentFromPayload(run?.payload);
    if (!run || !parent) return { notification: 'not_applicable' as const };
    const marker = (run.result as Record<string, unknown> | null)?.[
      `fastAgentArtifact:${artifact.id}`
    ];
    // Preserve settled notifications written by the previous inline delivery path.
    if (marker === 'delivered' || marker === 'skipped')
      return { notification: 'already_delivered' as const };
    const conversation = await tx.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, parent.sessionId),
      columns: { id: true },
    });
    if (!conversation) return { notification: 'skipped' as const };
    const admission = normalizeFastAgentParentEvent({
      parent,
      event: {
        type: 'artifact_published',
        taskId: input.taskId,
        runId: run.id,
        artifact: {
          id: artifact.id,
          path: artifact.path,
          version: artifact.version,
          contentType: artifact.contentType,
          viewUrl: buildArtifactViewUrl({
            taskId: input.taskId,
            path: artifact.path,
            version: artifact.version,
          }),
        },
      },
    });
    await tx
      .insert(fastAgentParentEvents)
      .values({
        conversationId: admission.parent.sessionId,
        eventKey: admission.eventKey,
        parent: admission.parent,
        event: admission.event,
      })
      .onConflictDoNothing({ target: fastAgentParentEvents.eventKey });
    return {
      notification: 'queued' as const,
      wake: {
        conversationId: admission.parent.sessionId,
        eventKey: admission.eventKey,
      },
    };
  });
  if ('wake' in result && result.wake) {
    // The durable event is authoritative. The existing recovery sweep recreates
    // a missed BullMQ wakeup and its delivery retry/backoff handles parent outages.
    void wakeFastAgentParentEventNow(result.wake).catch(() => {
      console.warn(
        `[artifactPublication] Notification wakeup deferred for artifact ${input.id}.`,
      );
    });
  }
  return result.notification;
}
