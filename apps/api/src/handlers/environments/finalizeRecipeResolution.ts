import type { Context } from 'hono';

import {
  db,
  eq,
  finalizeEnvironmentRecipeResolution,
  taskRuns,
} from '@roomote/db/server';
import {
  environmentRecipeSchema,
  getUnresolvedEnvironmentRecipeError,
} from '@roomote/types';
import { requireRecipeControlAdapter } from '@roomote/cloud-agents/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

function extractRunId(auth: McpAuth): number | null {
  return 'runId' in auth.authContext ? auth.authContext.runId : null;
}

/**
 * Resolve the calling task from its run token and require it to be the
 * environment-bound verification task that explicitly targets this
 * environment.
 */
async function resolveRecipeFinalizationCaller(
  auth: McpAuth,
  targetEnvironmentId: string,
): Promise<{ taskId: string } | null> {
  const runId = extractRunId(auth);

  if (!runId) {
    return null;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true, payload: true },
  });

  if (!taskRun?.taskId) {
    return null;
  }

  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return null;
  }

  const payload = taskRun.payload as Record<string, unknown>;
  const marker = payload.verifiesEnvironmentId;

  if (marker !== targetEnvironmentId) {
    return null;
  }

  return { taskId: taskRun.taskId };
}

/**
 * POST /api/mcp/environments/:id/recipe_resolution
 *
 * Worker-authenticated recipe finalization. The bound verification task
 * submits its resolved recipe; the dedicated database helper guards the
 * binding, fingerprints, and idempotency under a row lock.
 */
export async function finalizeRecipeResolution(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const id = c.req.param('id');

  if (!id) {
    return c.json({ error: 'Environment id is required' }, 400);
  }

  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object' || !('recipe' in body)) {
    return c.json({ error: 'recipe is required' }, 400);
  }

  const caller = await resolveRecipeFinalizationCaller(auth, id);

  if (!caller) {
    return c.json(
      {
        error:
          'This task is not authorized to finalize a recipe for this environment.',
      },
      403,
    );
  }

  const parsedRecipe = environmentRecipeSchema.safeParse(
    (body as { recipe: unknown }).recipe,
  );

  if (!parsedRecipe.success) {
    const issues = parsedRecipe.error.issues.map((issue) => issue.message);
    return c.json(
      { error: `Invalid environment recipe: ${issues.join(', ')}` },
      400,
    );
  }

  const recipe = parsedRecipe.data;

  if (getUnresolvedEnvironmentRecipeError({ environment_recipe: recipe })) {
    return c.json(
      { error: 'Finalization requires a resolved environment recipe.' },
      400,
    );
  }

  try {
    const result = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: id,
      verificationTaskId: caller.taskId,
      recipe,
      acceptRecipeResolution(candidate) {
        const adapter = requireRecipeControlAdapter(candidate.type);

        if (
          candidate.request_fingerprint !==
          adapter.computeRequestFingerprint(candidate.request)
        ) {
          return 'Request fingerprint does not match the request.';
        }

        const resolution = candidate.resolution;
        if (
          resolution &&
          resolution.resolution_fingerprint !==
            adapter.computeResolutionFingerprint(resolution)
        ) {
          return 'Resolution fingerprint does not match the resolution.';
        }

        const validation = adapter.validateResolvedRecipe(candidate);
        return validation.valid ? null : validation.error;
      },
    });

    if (result.status === 'stale') {
      return c.json(
        {
          error:
            'Finalization rejected: this task is no longer the current verification attempt for this environment.',
        },
        409,
      );
    }

    if (result.status === 'rejected') {
      return c.json({ error: result.reason }, 400);
    }

    return c.json({ success: true, environmentId: id });
  } catch (error) {
    logHandlerError('finalizeRecipeResolution', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to finalize the environment recipe',
      },
      500,
    );
  }
}
