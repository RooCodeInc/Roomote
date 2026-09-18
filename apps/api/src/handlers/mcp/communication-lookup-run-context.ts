import { db, eq, taskRuns } from '@roomote/db/server';

import { getTaskChannelBindings } from '../tasks/helpers';

import type { CommunicationLookupTaskRun } from './communication-message-lookup-types';
import { McpProxyError } from './proxy-utils';

export async function loadCommunicationLookupTaskRun(
  runId: number,
): Promise<CommunicationLookupTaskRun | null> {
  const run = await db.query.taskRuns.findFirst({
    columns: {
      actingUserId: true,
      taskId: true,
      payload: true,
    },
    where: eq(taskRuns.id, runId),
  });

  if (!run) return null;
  const bindings = await getTaskChannelBindings(run.taskId);
  return {
    actingUserId: run.actingUserId,
    payload: run.payload,
    slackChannelId: bindings?.slackChannelId ?? null,
    slackThreadTs: bindings?.slackThreadTs ?? null,
  };
}

export async function requireCommunicationLookupTaskRun(
  runId: number,
): Promise<CommunicationLookupTaskRun> {
  const taskRun = await loadCommunicationLookupTaskRun(runId);
  if (!taskRun) {
    throw new McpProxyError(404, 'Task run not found for this MCP token');
  }
  return taskRun;
}
