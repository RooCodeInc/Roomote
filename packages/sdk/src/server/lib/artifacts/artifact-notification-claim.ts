import { and, db, eq, sql, taskRuns } from '@roomote/db/server';
import {
  buildFastAgentDeliveryClaimPredicate,
  getDeliveryClaimExpiry,
} from '../task-runs/fast-agent-delivery-claim';

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ArtifactNotificationClaim =
  | { status: 'queued' | 'already_delivered' }
  | { status: 'in_progress'; retryAt: Date };

/** One ownership protocol shared by publication, queue delivery and N-1 handlers. */
export async function claimArtifactNotificationDelivery(
  tx: DbTx,
  runId: number,
  artifactId: string,
): Promise<ArtifactNotificationClaim> {
  const key = `fastAgentArtifact:${artifactId}`;
  const [claimed] = await tx
    .update(taskRuns)
    .set({
      result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${key}::text, 'queued'::text)`,
    })
    .where(
      and(eq(taskRuns.id, runId), buildFastAgentDeliveryClaimPredicate(key)),
    )
    .returning({ id: taskRuns.id });
  if (claimed) return { status: 'queued' };
  const run = await tx.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { result: true },
  });
  const marker = (run?.result as Record<string, unknown> | null)?.[key];
  if (marker === 'queued') return { status: 'queued' };
  const retryAt = getDeliveryClaimExpiry(marker);
  if (retryAt) return { status: 'in_progress', retryAt };
  return { status: 'already_delivered' };
}
