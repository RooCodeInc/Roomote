import type { TaskArtifactType } from '@roomote/types';
import {
  and,
  db,
  eq,
  max,
  sessions,
  sql,
  taskArtifacts,
} from '@roomote/db/server';

type ArtifactRecordOwner =
  | { taskId: string; sessionId?: never; runId?: number | null }
  | { taskId?: never; sessionId: string; runId?: never };

type CreateArtifactRecordInput = ArtifactRecordOwner & {
  artifactType: TaskArtifactType;
  contentType: string;
  path: string;
  size: number;
};

export async function createArtifactRecord(input: CreateArtifactRecordInput) {
  return await db.transaction(async (tx) => {
    const taskOwned = input.taskId !== undefined;

    if (!taskOwned) {
      const session = await tx.query.sessions.findFirst({
        where: eq(sessions.id, input.sessionId),
        columns: { id: true },
      });
      if (!session) throw new Error('Session not found.');
    }

    const ownerId = taskOwned ? input.taskId : input.sessionId;
    const lockOwner = taskOwned ? ownerId : `session:${ownerId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${lockOwner} || ':' || ${input.path}))`,
    );

    const ownerCondition = taskOwned
      ? eq(taskArtifacts.taskId, input.taskId)
      : eq(taskArtifacts.sessionId, input.sessionId);
    const maxVersionResult = await tx
      .select({ maxVersion: max(taskArtifacts.version) })
      .from(taskArtifacts)
      .where(and(ownerCondition, eq(taskArtifacts.path, input.path)))
      .limit(1);

    const newVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;
    const ownerValues = taskOwned
      ? { taskId: input.taskId, runId: input.runId ?? null }
      : { sessionId: input.sessionId };

    const [created] = await tx
      .insert(taskArtifacts)
      .values({
        ...ownerValues,
        artifactType: input.artifactType,
        contentType: input.contentType,
        path: input.path,
        version: newVersion,
        size: input.size,
        uploaded: false,
      })
      .returning();

    return created ?? null;
  });
}

export async function createTaskArtifactRecord(input: {
  taskId: string;
  runId?: number | null;
  artifactType: TaskArtifactType;
  contentType: string;
  path: string;
  size: number;
}) {
  return createArtifactRecord(input);
}
