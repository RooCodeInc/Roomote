import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  sql,
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
import { buildFastAgentDeliveryClaimPredicate } from '../task-runs/fast-agent-delivery-claim';

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
    const deliveryKey = `fastAgentArtifact:${artifact.id}`;
    // Share the previous handler's atomic lease predicate. A live inline owner
    // keeps delivery responsibility; an absent/expired lease may hand off. The
    // queued marker also prevents an old handler claiming after our admission.
    const [claimed] = await tx
      .update(taskRuns)
      .set({
        result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${deliveryKey}::text, 'queued'::text)`,
      })
      .where(
        and(
          eq(taskRuns.id, run.id),
          buildFastAgentDeliveryClaimPredicate(deliveryKey),
        ),
      )
      .returning({ id: taskRuns.id });
    if (!claimed) {
      const latest = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, run.id),
        columns: { result: true },
      });
      const currentMarker = (
        latest?.result as Record<string, unknown> | null
      )?.[deliveryKey];
      if (currentMarker === 'queued')
        return { notification: 'queued' as const };
      return {
        notification:
          typeof currentMarker === 'string' &&
          currentMarker.startsWith('delivering:')
            ? ('in_progress' as const)
            : ('already_delivered' as const),
      };
    }
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
