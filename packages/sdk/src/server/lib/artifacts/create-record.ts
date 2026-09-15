import type { TaskArtifactType } from '@roomote/types';
import {
  and,
  db,
  eq,
  max,
  sessions,
  sql,
  taskArtifacts,
  tasks,
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

    const [owner] = taskOwned
      ? await tx
          .select({ id: tasks.id, privacy: tasks.privacy })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .for('key share')
      : await tx
          .select({ id: sessions.id, privacy: sessions.privacy })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .for('key share');
    if (!owner) {
      throw new Error(taskOwned ? 'Task not found.' : 'Session not found.');
    }
    if (owner.privacy === 'private') {
      throw new Error(
        'Artifact publishing is unavailable in private Sessions.',
      );
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
