import {
  db,
  eq,
  getActiveAutomationRunForPrincipal,
  taskRuns,
} from '@roomote/db/server';

import type { Variables } from '../../types';

import {
  isRunTokenContext,
  isAutomationTokenContext,
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

  if (isAutomationTokenContext(authContext)) {
    const run = await getActiveAutomationRunForPrincipal({
      automationRunId: authContext.automationRunId,
      leaseOwner: authContext.leaseOwner,
      policyVersion: authContext.policyVersion,
    });
    if (!run) {
      throw new McpProxyError(403, 'Automation run token is no longer active');
    }
    return {
      userId: null,
      tokenType: 'automation',
      automationRunId: authContext.automationRunId,
      automationLeaseOwner: authContext.leaseOwner,
      automationPolicyVersion: authContext.policyVersion,
    };
  }

  if (authContext.tokenType === 'auth') {
    return { userId: authContext.userId, tokenType: 'auth' };
  }

  throw new McpProxyError(
    403,
    `${providerName} MCP requires a user, task run, or authorized automation token for server-side credential access`,
  );
}
