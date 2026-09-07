import { db, eq, taskRuns } from '@roomote/db/server';

import type { Variables } from '../../types';

import {
  isRunTokenContext,
  McpProxyError,
  type McpAuthContext,
} from './proxy-utils';

export async function resolveDeploymentMcpAuth(
  authContext: Variables['authContext'],
  providerName: string,
): Promise<McpAuthContext> {
  if (!authContext) {
    throw new McpProxyError(
      401,
      'Unauthorized: missing or invalid bearer token',
    );
  }

  if (isRunTokenContext(authContext)) {
    const taskRun = await db.query.taskRuns.findFirst({
      columns: { id: true },
      where: eq(taskRuns.id, authContext.runId),
    });

    if (!taskRun) {
      throw new McpProxyError(404, 'Task run not found for this MCP token');
    }

    // The run-scoped token is the authorization. Its user is mint-time
    // attribution and may differ from the task's current acting user.
    return {
      userId: authContext.userId,
      tokenType: 'run',
      runId: authContext.runId,
    };
  }

  if (authContext.tokenType === 'auth') {
    return { userId: authContext.userId, tokenType: 'auth' };
  }

  throw new McpProxyError(
    403,
    `${providerName} MCP requires a user auth token or task run token for server-side credential access`,
  );
}
