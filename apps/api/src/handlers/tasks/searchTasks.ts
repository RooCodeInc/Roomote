import type { Context } from 'hono';
import {
  HAS_PULL_REQUEST_FILTER_VALUE,
  isHiddenCloudTaskType,
} from '@roomote/types';

import {
  and,
  cloudJobs,
  db,
  desc,
  eq,
  lt,
  sql,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import {
  TASK_SELECT_COLUMNS,
  getLatestCloudJobsByTaskIds,
  visibleTaskHistoryCondition,
} from './helpers';
import { logHandlerError } from '../utils';

const SPECIFIC_PULL_REQUEST_FILTER_PATTERN =
  /^([^\s/#]+\/[^\s/#]+)#([1-9]\d*)$/u;

function parsePullRequestFilter(
  pullRequest: string,
):
  | { kind: 'has_pr' }
  | { kind: 'specific'; repo: string; prNumber: number }
  | null {
  if (pullRequest === HAS_PULL_REQUEST_FILTER_VALUE) {
    return { kind: 'has_pr' };
  }

  const match = SPECIFIC_PULL_REQUEST_FILTER_PATTERN.exec(pullRequest);

  if (!match) {
    return null;
  }

  const repo = match[1];
  const prNumber = match[2];

  if (!repo || !prNumber) {
    return null;
  }

  return {
    kind: 'specific',
    repo,
    prNumber: Number(prNumber),
  };
}

/**
 * GET /api/mcp/tasks
 *
 * Search tasks for the deployment.
 *
 * Query params:
 *   - query (string, optional): text search across task title and launch prompt
 *   - pullRequest (string, optional): "__has_pr__" or "owner/repo#123"
 *   - status (string, optional): "active" | "completed" | "all"
 *   - limit (number, optional, default 20, max 100)
 *   - cursor (string, optional): pagination cursor (activityAt:id or legacy activityAt)
 */
export async function searchTasks(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const query = c.req.query('query')?.trim();
  const pullRequestParam = c.req.query('pullRequest');
  const status = c.req.query('status') ?? 'all';

  if (!['active', 'completed', 'all'].includes(status)) {
    return c.json(
      { error: 'status must be one of: active, completed, all' },
      400,
    );
  }

  let pullRequestFilter:
    | { kind: 'has_pr' }
    | { kind: 'specific'; repo: string; prNumber: number }
    | undefined;

  if (pullRequestParam !== undefined) {
    const parsedPullRequest = parsePullRequestFilter(pullRequestParam.trim());

    if (parsedPullRequest === null) {
      return c.json(
        {
          error:
            'pullRequest must be "__has_pr__" or in the format owner/repo#number',
        },
        400,
      );
    }

    pullRequestFilter = parsedPullRequest;
  }

  let limit = 20;
  const limitParam = c.req.query('limit');

  if (limitParam !== undefined) {
    const parsedLimit = Number(limitParam);

    if (!Number.isFinite(parsedLimit)) {
      return c.json({ error: 'limit must be a number' }, 400);
    }

    limit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 100);
  }

  let cursorActivityAt: number | undefined;
  let cursorId: string | undefined;
  const cursorParam = c.req.query('cursor');

  if (cursorParam !== undefined) {
    // Compound cursor format: "activityAt:id" or legacy "activityAt"
    const parts = cursorParam.split(':');
    const parsedActivityAt = Number(parts[0]);

    if (!Number.isFinite(parsedActivityAt)) {
      return c.json({ error: 'cursor must be a number or activityAt:id' }, 400);
    }

    cursorActivityAt = Math.trunc(parsedActivityAt);
    cursorId = parts[1];
  }

  try {
    const conditions = [visibleTaskHistoryCondition];

    if (query) {
      // Escape LIKE metacharacters so literal %, _ in user input are matched verbatim
      const escaped = query.replace(/[%_\\]/g, (ch) => '\\' + ch);

      conditions.push(
        sql`(
          ${tasks.title} ILIKE ${'%' + escaped + '%'} ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM ${cloudJobs}
            WHERE ${cloudJobs.taskId} = ${tasks.id}
              AND ${cloudJobs.payload}->>'description' ILIKE ${'%' + escaped + '%'} ESCAPE '\\'
          )
        )`,
      );
    }

    if (pullRequestFilter) {
      if (pullRequestFilter.kind === 'has_pr') {
        conditions.push(
          sql`EXISTS (
            SELECT 1
            FROM ${taskPullRequests}
            WHERE ${taskPullRequests.taskId} = ${tasks.id}
              AND ${taskPullRequests.repository} IS NOT NULL
              AND ${taskPullRequests.prNumber} IS NOT NULL
          )`,
        );
      } else {
        conditions.push(
          sql`EXISTS (
            SELECT 1
            FROM ${taskPullRequests}
            WHERE ${taskPullRequests.taskId} = ${tasks.id}
              AND ${taskPullRequests.repository} = ${pullRequestFilter.repo}
              AND ${taskPullRequests.prNumber} = ${pullRequestFilter.prNumber}
          )`,
        );
      }
    }

    if (status === 'active') {
      conditions.push(eq(tasks.completed, false));
    } else if (status === 'completed') {
      conditions.push(eq(tasks.completed, true));
    }

    if (cursorActivityAt !== undefined) {
      if (cursorId) {
        // Compound cursor: skip rows at the same activityAt with id >= cursorId
        conditions.push(
          sql`(${tasks.activityAt} < ${cursorActivityAt} OR (${tasks.activityAt} = ${cursorActivityAt} AND ${tasks.id} < ${cursorId}))`,
        );
      } else {
        // Legacy numeric cursor (backward compatible)
        conditions.push(lt(tasks.activityAt, cursorActivityAt));
      }
    }

    const results = await db
      .selectDistinct(TASK_SELECT_COLUMNS)
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.activityAt), desc(tasks.id))
      .limit(limit + 1);

    const hasMore = results.length === limit + 1;

    const lastItem = hasMore ? results[limit - 1] : undefined;
    const nextCursor =
      lastItem !== undefined
        ? `${lastItem.activityAt}:${lastItem.id}`
        : undefined;

    const taskList = hasMore ? results.slice(0, limit) : results;

    const taskIds = taskList.map((task) => task.id);
    const latestJobs = await getLatestCloudJobsByTaskIds(taskIds);
    const visibleTaskList = taskList.filter((task) => {
      const latestJob = latestJobs[task.id];
      return latestJob ? !isHiddenCloudTaskType(latestJob.type) : true;
    });

    return c.json({
      tasks: visibleTaskList.map((t) => ({
        id: t.id,
        title: t.title,
        mode: t.mode,
        completed: t.completed,
        repositoryName: t.repositoryName,
        harness: t.harness,
        createdAt: t.timestamp,
        lastMessageAt: t.activityAt,
        cloudJobStatus: latestJobs[t.id]?.status ?? null,
        taskPhase: latestJobs[t.id]?.taskPhase ?? null,
        cloudJobError: latestJobs[t.id]?.error ?? null,
      })),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logHandlerError('searchTasks', error);
    return c.json({ error: 'Failed to search tasks' }, 500);
  }
}
