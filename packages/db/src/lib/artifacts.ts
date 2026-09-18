import { and, desc, eq } from 'drizzle-orm';

import { db } from '../db';
import { taskArtifacts, tasks } from '../schema';

// Exact reads include incomplete upload metadata; latest reads only serve uploads.
function artifactVersionCondition(version: number | undefined) {
  return version !== undefined
    ? eq(taskArtifacts.version, version)
    : eq(taskArtifacts.uploaded, true);
}

export async function getTaskArtifactByPath(input: {
  taskId: string;
  path: string;
  version?: number;
}) {
  const [row] = await db
    .select()
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(
      and(
        eq(taskArtifacts.taskId, input.taskId),
        eq(taskArtifacts.path, input.path),
        artifactVersionCondition(input.version),
      ),
    )
    .orderBy(desc(taskArtifacts.version))
    .limit(1);

  return row ? { ...row.task_artifacts, task: row.tasks } : null;
}

export async function getSessionArtifactByPath(input: {
  sessionId: string;
  path: string;
  version?: number;
}) {
  const [artifact] = await db
    .select()
    .from(taskArtifacts)
    .where(
      and(
        eq(taskArtifacts.sessionId, input.sessionId),
        eq(taskArtifacts.path, input.path),
        artifactVersionCondition(input.version),
      ),
    )
    .orderBy(desc(taskArtifacts.version))
    .limit(1);

  return artifact ?? null;
}
