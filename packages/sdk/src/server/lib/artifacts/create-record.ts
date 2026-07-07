import type { TaskArtifactType } from '@roomote/types';
import { and, db, eq, max, sql, taskArtifacts } from '@roomote/db/server';

export async function createTaskArtifactRecord(input: {
  taskId: string;
  cloudJobId?: number | null;
  artifactType: TaskArtifactType;
  contentType: string;
  path: string;
  size: number;
}) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.taskId} || ':' || ${input.path}))`,
    );

    const maxVersionResult = await tx
      .select({ maxVersion: max(taskArtifacts.version) })
      .from(taskArtifacts)
      .where(
        and(
          eq(taskArtifacts.taskId, input.taskId),
          eq(taskArtifacts.path, input.path),
        ),
      )
      .limit(1);

    const newVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

    const [created] = await tx
      .insert(taskArtifacts)
      .values({
        taskId: input.taskId,
        cloudJobId: input.cloudJobId ?? null,
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
