import type { Context } from 'hono';
import { z } from 'zod';

import { TaskPayloadKind, type TaskPayload } from '@roomote/types';
import { normalizeSetupNewState } from '@roomote/types';
import { Env } from '@roomote/env';
import { db, eq, taskRuns, tasks } from '@roomote/db/server';
import {
  hydrateSetupMcpRecommendations,
  isSetupMcpRecommendationId,
  normalizeEnabledSetupMcpIntegrationIds,
} from '@roomote/cloud-agents/server';
import { postSetupMcpRecommendationsToSlack } from '@roomote/slack';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

const minimalMcpRecommendationSchema = z
  .object({
    id: z.string().refine(isSetupMcpRecommendationId),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

const fullMcpRecommendationSchema = z
  .object({
    id: z.string().refine(isSetupMcpRecommendationId),
    name: z.string().trim().min(1),
    category: z.enum(['built_in_integration', 'org_integration']),
    description: z.string().trim().min(1),
    capabilities: z.array(z.string().trim().min(1)).min(1),
    setupLocation: z.string().trim().min(1),
    priority: z.enum(['high', 'medium', 'low']),
    rationale: z.string().trim().min(1),
  })
  .strict();

const submitMcpRecommendationsBodySchema = z.object({
  recommendations: z
    .array(
      z.union([minimalMcpRecommendationSchema, fullMcpRecommendationSchema]),
    )
    .max(20),
});

const ACTIVE_SETUP_TASK_TYPES = new Set<TaskPayloadKind>([
  TaskPayloadKind.StandardTask,
  TaskPayloadKind.McpRecommendations,
  TaskPayloadKind.SnapshotResume,
]);

type McpRecommendationsPayload = TaskPayload<
  typeof TaskPayloadKind.McpRecommendations
>;

/**
 * POST /api/mcp/tasks/:taskId/mcp_recommendations
 *
 * Persist and post MCP recommendations tied to the active setup flow.
 */
export async function submitMcpRecommendations(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsedBody = submitMcpRecommendationsBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return c.json({ error: 'Invalid MCP recommendations payload' }, 400);
  }

  try {
    const [run, task, deploymentSettings] = await Promise.all([
      db.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, taskId),
        orderBy: (table, { desc }) => desc(table.id),
        columns: {
          id: true,
          payloadKind: true,
          actingUserId: true,
          payload: true,
        },
      }),
      db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: {
          initiatorUserId: true,
        },
      }),
      db.query.deploymentSettings.findFirst({
        columns: {
          setupNewState: true,
        },
      }),
    ]);

    if (!run) {
      return c.json({ error: 'Task not found' }, 404);
    }

    if (!('runId' in auth.authContext) || auth.authContext.runId !== run.id) {
      return c.json({ error: 'Task access denied' }, 403);
    }

    if (!ACTIVE_SETUP_TASK_TYPES.has(run.payloadKind)) {
      return c.json({ error: 'Task is not a setup task' }, 400);
    }

    const setupNewState = normalizeSetupNewState(
      deploymentSettings?.setupNewState ?? {},
    );

    const sourceTaskId =
      run.payloadKind === TaskPayloadKind.McpRecommendations
        ? (run.payload as McpRecommendationsPayload).sourceTaskId
        : taskId;

    if (
      setupNewState.onboardingTaskId &&
      setupNewState.onboardingTaskId !== sourceTaskId
    ) {
      return c.json(
        {
          error:
            'This setup task is no longer active for the current onboarding session.',
        },
        409,
      );
    }

    const recommendations = parsedBody.data.recommendations.every(
      (recommendation) => 'name' in recommendation,
    )
      ? parsedBody.data.recommendations
      : hydrateSetupMcpRecommendations(
          parsedBody.data.recommendations.map((recommendation) => ({
            id: recommendation.id,
            rationale: recommendation.rationale,
          })),
        );

    const payload =
      run.payloadKind === TaskPayloadKind.McpRecommendations
        ? (run.payload as McpRecommendationsPayload)
        : null;

    const configuredRecommendationIds = new Set(
      normalizeEnabledSetupMcpIntegrationIds(payload?.currentConfig),
    );
    const filteredRecommendations = recommendations.filter(
      (recommendation) =>
        !configuredRecommendationIds.has(recommendation.id.toLowerCase()),
    );

    if (filteredRecommendations.length === 0) {
      return c.json({
        success: true,
        recommendationCount: 0,
        posted: false,
        reason: 'no_supported_recommendations',
      });
    }

    const postResult = await postSetupMcpRecommendationsToSlack({
      sourceTaskId,
      slackChannel: payload?.slackChannel ?? setupNewState.slackChannel,
      createdByUserId:
        payload?.installerUserId ??
        auth.userId ??
        run.actingUserId ??
        task?.initiatorUserId ??
        setupNewState.lastInteractedByUserId ??
        null,
      recommendations: filteredRecommendations,
      appBaseUrl: Env.ROOMOTE_APP_URL,
      targetEnvironmentId: payload?.environmentId ?? null,
    });

    return c.json({
      success: true,
      recommendationCount: filteredRecommendations.length,
      posted: postResult.posted,
      reason: postResult.reason ?? null,
    });
  } catch (error) {
    logHandlerError('submitMcpRecommendations', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to submit MCP recommendations',
      },
      500,
    );
  }
}
