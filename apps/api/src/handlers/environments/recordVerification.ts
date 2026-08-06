import type { Context } from 'hono';

import {
  db,
  environments,
  eq,
  recordEnvironmentVerification,
  taskRuns,
} from '@roomote/db/server';
import {
  canPerformEnvironmentManagementAction,
  getEnvironmentDefinitionIdFromPayload,
  resolveEnvironmentManagementMode,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

const MAX_VERIFICATION_ERROR_LENGTH = 2_000;

/**
 * Reduce an agent-provided failure message to a compact, user-safe string.
 *
 * Never persist secrets or full environment YAML. This drops lines that look
 * like key/value assignments or YAML mappings (which could carry credentials),
 * collapses whitespace, and truncates to a bounded length.
 */
export function sanitizeVerificationError(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const withoutSecrets = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      // Drop lines that look like environment-variable assignments, secret
      // key/value pairs, or YAML mappings (`key: value` / `- key: value`) to
      // avoid persisting credentials or dumping full environment YAML. Matched
      // case-insensitively so lowercase keys are covered too.
      return !/^(?:-\s*)?(?:export\s+)?[A-Za-z0-9_.-]{2,}\s*[:=]\s*\S/.test(
        trimmed,
      );
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutSecrets) {
    return null;
  }

  return withoutSecrets.length > MAX_VERIFICATION_ERROR_LENGTH
    ? `${withoutSecrets.slice(0, MAX_VERIFICATION_ERROR_LENGTH - 1)}…`
    : withoutSecrets;
}

function extractRunId(auth: McpAuth): number | null {
  return 'runId' in auth.authContext ? auth.authContext.runId : null;
}

/**
 * Resolve the calling verification task from its run token.
 *
 * Only run-token tasks carrying a verification marker in their payload may
 * record verification, and only for that exact environment. Returns the
 * calling task's own Roomote taskId (the identity used to match the current
 * verification attempt) alongside the authorized environment id, or null when
 * the caller is not an authorized verification flow for the target
 * environment.
 */
async function resolveVerificationCaller(
  auth: McpAuth,
  targetEnvironmentId: string,
): Promise<{ taskId: string } | null> {
  const runId = extractRunId(auth);

  if (!runId) {
    return null;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true, payload: true, payloadKind: true },
    with: { task: { columns: { workflow: true } } },
  });

  if (!taskRun?.taskId) {
    return null;
  }

  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return null;
  }

  const payload = taskRun.payload as Record<string, unknown>;
  const mode = resolveEnvironmentManagementMode({
    payloadKind: taskRun.payloadKind,
    payload,
    workflow: taskRun.task.workflow,
  });

  if (!canPerformEnvironmentManagementAction(mode, 'record_verification')) {
    return null;
  }

  const marker = payload.verifiesEnvironmentId;

  const authorizedEnvironmentId =
    typeof marker === 'string' && marker.trim().length > 0
      ? marker.trim()
      : // Fall back to the environment-definition marker so the
        // environment-setup skill's own setup task (which records the result
        // after monitoring its spawned verification sub-task) is authorized
        // for the environment it just persisted.
        getEnvironmentDefinitionIdFromPayload(payload);

  if (
    !authorizedEnvironmentId ||
    authorizedEnvironmentId !== targetEnvironmentId
  ) {
    return null;
  }

  return { taskId: taskRun.taskId };
}

/**
 * POST /api/mcp/environments/:id/verification
 *
 * Records the terminal result of an environment verification task. Only the
 * active verification flow for this environment may call it. The recording
 * task's identity is derived server-side from the run token, so a task cannot
 * record a result on behalf of another verification attempt.
 */
export async function recordVerification(
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

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body is required' }, 400);
  }

  const requestBody = body as {
    success?: unknown;
    error?: unknown;
  };

  if (typeof requestBody.success !== 'boolean') {
    return c.json({ error: 'success must be a boolean' }, 400);
  }

  const caller = await resolveVerificationCaller(auth, id);

  if (!caller) {
    return c.json(
      {
        error:
          'This task is not authorized to record verification for this environment.',
      },
      403,
    );
  }

  try {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, id),
      columns: { id: true },
    });

    if (!environment) {
      return c.json({ error: 'Environment not found' }, 404);
    }

    const sanitizedError = requestBody.success
      ? null
      : sanitizeVerificationError(requestBody.error);

    const { recorded } = await recordEnvironmentVerification(db, {
      environmentId: id,
      // Match against the caller's own task id, derived server-side.
      verificationTaskId: caller.taskId,
      success: requestBody.success,
      error: sanitizedError,
    });

    if (!recorded) {
      // The environment's current verification task no longer matches this
      // caller (a newer verification, retry, or runtime-affecting edit
      // superseded it). Reject rather than clobber the newer state.
      return c.json(
        {
          error:
            'Verification result rejected: it does not match the current verification attempt for this environment.',
        },
        409,
      );
    }

    return c.json({
      success: true,
      environmentId: id,
      isVerified: requestBody.success,
    });
  } catch (error) {
    logHandlerError('recordVerification', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to record verification',
      },
      500,
    );
  }
}
