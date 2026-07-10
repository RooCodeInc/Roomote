import { z } from 'zod';

import { TaskPayloadKind } from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';
import {
  createLinearClient,
  drainLinearMessagesToResumeJob,
  type AgentSessionPlanStep,
} from '@roomote/linear';

import { getValidAccessToken } from '../lib/mcp/data';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from '../lib/mcp/linear-connections';
import {
  authenticatedProcedure,
  jobScoped,
  nonJobProcedure,
  router,
} from '../trpc';

async function findActiveConnection() {
  return findLinearDeploymentMcpConnection();
}

async function getLinearClient() {
  const connection = await findActiveConnection();

  if (!connection) {
    throw new Error('Linear connection not found.');
  }

  const accessToken = await getValidAccessToken(
    connection.id,
    'https://mcp.linear.app/mcp',
  );
  if (!accessToken) {
    throw new Error('Linear access token not available.');
  }

  return createLinearClient(accessToken);
}

export const linearSessionsRouter = router({
  findFirst: nonJobProcedure.query(async () => {
    const connection = await findActiveConnection();
    if (!connection) {
      return null;
    }

    const metadata = getLinearDeploymentMetadata(connection.authConfig);
    if (!metadata) {
      return null;
    }

    return {
      id: connection.id,
      authStatus: connection.authStatus,
      linearOrganizationId: metadata.linearOrganizationId,
      linearOrganizationName: metadata.linearOrganizationName,
      linearOrganizationUrlKey: metadata.linearOrganizationUrlKey,
      appUserId: metadata.appUserId,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }),

  hasActiveConnection: authenticatedProcedure.query(async () => {
    const connection = await findActiveConnection();
    return connection?.authStatus === 'authenticated';
  }),

  emitAction: authenticatedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        action: z.string(),
        parameter: z.string(),
        result: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getLinearClient();
      await client.emitAction(
        input.sessionId,
        input.action,
        input.parameter,
        input.result,
      );
    }),

  emitThought: authenticatedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string(),
        ephemeral: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getLinearClient();
      await client.emitThought(input.sessionId, input.content, input.ephemeral);
    }),

  emitResponse: authenticatedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getLinearClient();
      await client.emitResponse(input.sessionId, input.content);
    }),

  emitElicitation: authenticatedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string(),
        signal: z.enum(['select']).optional(),
        signalMetadata: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getLinearClient();
      await client.emitElicitation(input.sessionId, input.content, {
        signal: input.signal,
        signalMetadata: input.signalMetadata,
      });
    }),

  updateSessionPlan: authenticatedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        plan: z.array(
          z.object({
            content: z.string(),
            status: z.enum(['pending', 'inProgress', 'completed', 'canceled']),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getLinearClient();
      await client.updateSessionPlan(
        input.sessionId,
        input.plan as AgentSessionPlanStep[],
      );
    }),

  drainLinearMessages: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).mutation(async ({ input }) => {
    const cloudJob = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.cloudJobId),
      with: { task: true },
    });

    if (!cloudJob) {
      return { resumed: false, reason: 'job_not_found' } as const;
    }

    if (
      cloudJob.payloadKind !== TaskPayloadKind.LinearAgentSession &&
      cloudJob.payloadKind !== TaskPayloadKind.SnapshotResume
    ) {
      return { resumed: false, reason: 'not_linear_job' } as const;
    }

    const task = cloudJob.task;

    const result = await drainLinearMessagesToResumeJob({
      id: cloudJob.id,
      linearSessionId: task.linearSessionId,
      linearIssueId: task.linearIssueId,
      linearOrganizationId: task.linearOrganizationId,
      slackThreadTs: task.slackThreadTs,
      snapshotId: cloudJob.snapshotId,
      payload: cloudJob.payload as Record<string, unknown>,
      port: cloudJob.port,
    });

    if (result.resumed) {
      return result;
    }

    return result;
  }),
});
