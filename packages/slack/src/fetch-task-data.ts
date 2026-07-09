import { formatSingleLineLog, getUserDisplayName } from '@roomote/types';
import {
  db,
  tasks,
  users,
  taskRuns,
  slackUserMappings,
  slackInstallations,
  eq,
  and,
  desc,
  type User,
  type Task,
  type CloudJob,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';

import type { TaskUnfurlData } from './types';

function toUnixSeconds(date: Date | null | undefined): number {
  if (!date) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(date.getTime() / 1000);
}

function deriveStatus(task: Task, job: CloudJob | null): string {
  if (job?.status) {
    return job.status;
  }

  // Terminal task state ('completed' | 'failed' | 'canceled') is authoritative
  // once set; 'active' means no terminal transition has been recorded yet.
  return task.state === 'active' ? 'pending' : task.state;
}

/**
 * Fetches the domain-level data required to build a Slack task unfurl.
 *
 * This function loads the task and its related entities from the database
 * using Drizzle ORM, applies sensible fallbacks for missing data, and normalizes
 * the result into a {@link TaskUnfurlData} object.
 *
 * Returned timestamps are expressed as UNIX epoch seconds.
 *
 * @param taskId - ID of the task being unfurled.
 * @returns A {@link TaskUnfurlData} object when the task exists; otherwise `null`.
 */
export async function fetchTaskDataForUnfurl(
  taskId: string,
): Promise<TaskUnfurlData | null> {
  try {
    if (!taskId) {
      console.warn('[SlackUnfurl] Missing taskId when fetching task data', {
        taskId,
      });

      return null;
    }

    const taskWithRelations = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!taskWithRelations) {
      return null;
    }

    let taskUser: User | null = null;

    if (taskWithRelations.initiatorUserId) {
      taskUser =
        (await db.query.users.findFirst({
          where: eq(users.id, taskWithRelations.initiatorUserId),
        })) ?? null;
    }

    const job =
      (await db.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, taskWithRelations.id),
        orderBy: [desc(taskRuns.id)],
      })) ?? null;

    const creatorUser = taskUser;
    const createdBy =
      getUserDisplayName(taskUser) ||
      taskWithRelations.actorDisplayName ||
      'Unknown User';

    // Look up the Slack user ID for the creator if we have a user ID.
    // Join with slackInstallations to ensure we get the mapping for the
    // currently active Slack installation (handles org reinstalls with different teams).
    let createdBySlackUserId: string | undefined;

    if (creatorUser?.id) {
      const slackMapping = await db.query.slackUserMappings.findFirst({
        where: and(
          eq(slackUserMappings.userId, creatorUser.id),
          eq(
            slackUserMappings.slackTeamId,
            db
              .select({ teamId: slackInstallations.teamId })
              .from(slackInstallations)
              .where(eq(slackInstallations.isActive, true))
              .limit(1),
          ),
        ),
      });

      createdBySlackUserId = slackMapping?.slackUserId;
    }

    const assignee = null;

    const createdAt = toUnixSeconds(taskWithRelations.createdAt);
    const updatedAt = toUnixSeconds(taskWithRelations.updatedAt);

    const status = deriveStatus(taskWithRelations, job);

    const url = getTaskUrl({
      taskId,
      utm: { campaign: job?.payloadKind ?? '', source: 'slack-unfurl' },
    });

    const result: TaskUnfurlData = {
      taskId,
      title: taskWithRelations.title,
      status,
      createdBy,
      createdBySlackUserId,
      assignee,
      createdAt,
      updatedAt,
      url,
    };

    return result;
  } catch (error) {
    console.error(
      formatSingleLineLog(
        '[SlackUnfurl] Failed to fetch task data for unfurl',
        {
          taskId,
          error,
        },
      ),
    );

    return null;
  }
}
