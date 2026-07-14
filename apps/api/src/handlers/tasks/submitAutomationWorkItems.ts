import type { Context } from 'hono';

import { TaskPayloadKind } from '@roomote/types';
import { db, eq, taskRuns, tasks } from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import { submitAutoActWorkItems } from './automation-work-items/auto-act.js';
import { AutomationWorkItemValidationError } from './automation-work-items/prepare.js';
import { submitAutomationWorkItemsBodySchema } from './automation-work-items/schema.js';
import { isAutomationWorkItemSource } from './automation-work-items/source.js';
import type { SuggestedTasksPayload } from './automation-work-items/types.js';

/**
 * POST /api/mcp/tasks/:taskId/automation_work_items
 */
export async function submitAutomationWorkItems(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'Task ID is required' }, 400);
  }

  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsedBody = submitAutomationWorkItemsBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.issues[0]?.message ?? 'Invalid request body' },
      400,
    );
  }

  try {
    const [run, task] = await Promise.all([
      db.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, taskId),
        orderBy: (table, { desc }) => desc(table.id),
        columns: {
          payloadKind: true,
          actingUserId: true,
          payload: true,
        },
      }),
      db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: {
          initiatorUserId: true,
          initiatorAutomation: true,
        },
      }),
    ]);

    if (!run) {
      return c.json({ error: 'Task not found' }, 404);
    }

    // Initiator stamp catches the new StandardTask CI path (no suggestionSource).
    if (task?.initiatorAutomation === 'ci_failure_triage') {
      return c.json(
        {
          error:
            'CI failure triage no longer uses automation work items. Investigate and fix in the launched standard task.',
        },
        400,
      );
    }

    if (run.payloadKind !== TaskPayloadKind.Scan) {
      return c.json({ error: 'Task is not an automation scan task' }, 400);
    }

    const payload = run.payload as SuggestedTasksPayload;
    const automationSource = payload.suggestionSource;

    // The task's immutable initiator stamp is the source of truth for which
    // automation launched this scan; the payload source must match it.
    if (
      !isAutomationWorkItemSource(automationSource) ||
      automationSource !== task?.initiatorAutomation
    ) {
      return c.json(
        {
          error: 'Automation work items are not supported for this task source',
        },
        400,
      );
    }

    try {
      return c.json(
        await submitAutoActWorkItems({
          userId:
            auth.userId ?? run.actingUserId ?? task?.initiatorUserId ?? null,
          taskId,
          automationKey: automationSource,
          payload,
          workItems: parsedBody.data.workItems,
        }),
      );
    } catch (error) {
      if (error instanceof AutomationWorkItemValidationError) {
        return c.json({ error: error.message }, 400);
      }

      throw error;
    }
  } catch (error) {
    logHandlerError('submitAutomationWorkItems', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to submit automation work items',
      },
      500,
    );
  }
}
