import { type TaskArtifactType } from '@roomote/types';
import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm';

import { db } from '../db';
import { taskArtifacts, tasks } from '../schema';

// Exact reads include incomplete upload metadata; latest reads only serve uploads.
function artifactVersionCondition(version: number | undefined) {
  return version !== undefined
    ? eq(taskArtifacts.version, version)
    : eq(taskArtifacts.uploaded, true);
}

export async function listLatestTaskArtifacts(input: {
  taskId: string;
  artifactType?: TaskArtifactType;
}) {
  const whereConditions = [
    eq(taskArtifacts.taskId, input.taskId),
    eq(taskArtifacts.uploaded, true),
  ];

  if (input.artifactType !== undefined) {
    whereConditions.push(eq(taskArtifacts.artifactType, input.artifactType));
  }

  // Rank in SQL while retaining the existing first-upload ordering per path.
  const rankedArtifacts = db
    .select({
      ...getTableColumns(taskArtifacts),
      firstCreatedAt:
        sql<Date>`min(${taskArtifacts.createdAt}) over (partition by ${taskArtifacts.path})`.as(
          'first_created_at',
        ),
      versionRank:
        sql<number>`row_number() over (partition by ${taskArtifacts.path} order by ${taskArtifacts.version} desc)`.as(
          'version_rank',
        ),
    })
    .from(taskArtifacts)
    .where(and(...whereConditions))
    .as('ranked_task_artifacts');

  const rows = await db
    .select()
    .from(rankedArtifacts)
    .where(eq(rankedArtifacts.versionRank, 1))
    .orderBy(asc(rankedArtifacts.firstCreatedAt), asc(rankedArtifacts.path));

  return rows.map(
    ({ firstCreatedAt: _, versionRank: __, ...artifact }) => artifact,
  );
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
