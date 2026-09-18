import type { Context } from 'hono';

import {
  and,
  db,
  desc,
  environments,
  eq,
  fastAgentParentEvents,
  sql,
  taskMessages,
  tasks,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  getLinkedEnvironmentIdFromPayload,
  getTerminalProviderErrorFromMessageData,
} from '@roomote/types';
import { redactSecrets } from '@roomote/communication/redact-secrets';
import { Env } from '@roomote/env';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { customAutomationHistoryAccess } from '../custom-automation-history-access';

import {
  getLatestTaskRunsByTaskIds,
  TASK_SELECT_COLUMNS,
  visibleTaskHistoryCondition,
} from './helpers';
import { logHandlerError } from '../utils';
import { listArtifactsByTask } from '../artifacts/service';

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

/**
 * GET /api/tasks/:taskId/summary
 *
 * Get a summary of a specific task including MCP-facing metadata.
 */
export async function getTaskSummary(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  try {
    const [task] = await db
      .select(TASK_SELECT_COLUMNS)
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          visibleTaskHistoryCondition,
          customAutomationHistoryAccess(c.get('mcpAuth'), 'task'),
        ),
      )
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const latestRuns = await getLatestTaskRunsByTaskIds([task.id]);
    const latestRun = latestRuns[task.id] ?? null;
    const parent = getFastAgentParentFromPayload(latestRun?.payload);
    const linkedEnvironmentId = getLinkedEnvironmentIdFromPayload(
      latestRun?.payload,
    );
    const [linkedEnvironment, artifacts, latestReport, terminalMessage] =
      await Promise.all([
        linkedEnvironmentId
          ? db.query.environments.findFirst({
              where: eq(environments.id, linkedEnvironmentId),
              columns: { id: true, name: true },
            })
          : null,
        listArtifactsByTask({ taskId: task.id, auth: {} }),
        parent
          ? db.query.fastAgentParentEvents.findFirst({
              where: and(
                eq(fastAgentParentEvents.conversationId, parent.sessionId),
                sql`${fastAgentParentEvents.event} ->> 'type' = 'child_message'`,
                sql`${fastAgentParentEvents.event} ->> 'taskId' = ${task.id}`,
              ),
              orderBy: [
                desc(fastAgentParentEvents.createdAt),
                desc(fastAgentParentEvents.id),
              ],
              columns: { event: true, createdAt: true },
            })
          : null,
        latestRun
          ? db.query.taskMessages.findFirst({
              where: and(
                eq(taskMessages.taskId, task.id),
                eq(taskMessages.runId, latestRun.id),
                eq(taskMessages.eventType, 'roomote_runtime.assistant_message'),
                sql`coalesce(${taskMessages.metadata} -> 'terminalProviderError' ->> 'errorSummary', ${taskMessages.payload} -> 'terminalProviderError' ->> 'errorSummary') is not null`,
              ),
              orderBy: [desc(taskMessages.ts), desc(taskMessages.createdAt)],
              columns: { metadata: true, payload: true, createdAt: true },
            })
          : null,
      ]);
    const terminalError =
      getTerminalProviderErrorFromMessageData(terminalMessage?.metadata) ??
      getTerminalProviderErrorFromMessageData(terminalMessage?.payload);
    // Terminal provider errors end a turn without making the session unresumable.
    // Only a later closeout from this attempt can supersede that blocker. Compare
    // database timestamps here, not the sandbox clock used by message.ts.
    const unresolvedProviderError =
      terminalError &&
      !(
        latestReport?.event.runId === latestRun?.id &&
        latestReport?.event.purpose === 'closeout' &&
        terminalMessage &&
        latestReport.createdAt > terminalMessage.createdAt
      )
        ? terminalError.errorSummary
        : null;
    // reportToParentSession durably stores the task's literal response here.
    const summary =
      !unresolvedProviderError &&
      typeof latestReport?.event.message === 'string'
        ? latestReport.event.message
        : null;
    const mediaArtifacts = artifacts
      .filter(
        (artifact) =>
          artifact.contentType.startsWith('image/') ||
          artifact.contentType.startsWith('video/'),
      )
      .map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        version: artifact.version,
        artifactType: artifact.artifactType,
        contentType: artifact.contentType,
        viewUrl: buildArtifactViewUrl({
          taskId: task.id,
          path: artifact.path,
          version: artifact.version,
        }),
      }));

    return c.json({
      id: task.id,
      title: task.title,
      summary: summary?.trim() ? redactSecrets(summary) : null,
      mode: task.mode,
      completed: task.state === 'completed',
      state: task.state,
      repositoryName: task.repositoryName,
      harness: task.harness,
      createdAt: task.timestamp,
      taskRunStatus: latestRun?.status ?? null,
      taskPhase: latestRun?.taskPhase ?? null,
      taskRunError:
        latestRun?.error ??
        (unresolvedProviderError
          ? redactSecrets(unresolvedProviderError)
          : null),
      environmentSetupState: latestRun?.environmentSetupState ?? null,
      linkedEnvironmentId: linkedEnvironmentId ?? null,
      linkedEnvironmentName: linkedEnvironment?.name ?? null,
      imageArtifacts: mediaArtifacts.filter((artifact) =>
        artifact.contentType.startsWith('image/'),
      ),
      videoArtifacts: mediaArtifacts.filter((artifact) =>
        artifact.contentType.startsWith('video/'),
      ),
    });
  } catch (error) {
    logHandlerError('getTaskSummary', error);
    return c.json({ error: 'Failed to get task summary' }, 500);
  }
}
