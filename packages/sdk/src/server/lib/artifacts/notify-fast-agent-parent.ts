import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  isNull,
  fastAgentConversations,
  fastAgentParentEvents,
  taskArtifacts,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  normalizeFastAgentParentEvent,
  wakeFastAgentParentEventNow,
  wakeFastAgentParentEventAt,
} from '../fast-agent-parent-event-queue';
import { claimArtifactNotificationDelivery } from './artifact-notification-claim';

export type FastArtifactNotificationResult =
  | 'not_applicable'
  | 'already_delivered'
  | 'in_progress'
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
    const claim = await claimArtifactNotificationDelivery(
      tx,
      run.id,
      artifact.id,
    );
    if (claim.status === 'already_delivered')
      return { notification: claim.status };
    const retryAt = claim.status === 'in_progress' ? claim.retryAt : undefined;
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
        claimedUntil: retryAt ?? null,
      })
      .onConflictDoUpdate({
        target: fastAgentParentEvents.eventKey,
        // Only alter the legacy hold; preserve any queue delivery backoff.
        set: { claimedUntil: retryAt ?? null, updatedAt: new Date() },
        setWhere: and(
          isNull(fastAgentParentEvents.deliveredAt),
          isNull(fastAgentParentEvents.discardedAt),
        ),
      });
    return {
      notification: claim.status,
      retryAt,
      wake: {
        conversationId: admission.parent.sessionId,
        eventKey: admission.eventKey,
      },
    };
  });
  if ('wake' in result && result.wake) {
    // The durable event is authoritative. The existing recovery sweep recreates
    // a missed BullMQ wakeup and its delivery retry/backoff handles parent outages.
    const wakeup = result.retryAt
      ? wakeFastAgentParentEventAt(result.wake, result.retryAt)
      : wakeFastAgentParentEventNow(result.wake);
    void wakeup.catch(() => {
      console.warn(
        `[artifactPublication] Notification wakeup deferred for artifact ${input.id}.`,
      );
    });
  }
  return result.notification;
}
