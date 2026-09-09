import type { RunTokenContext } from '@roomote/types';
import {
  and,
  db,
  eq,
  isVisibleTask,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { findTaskRunByRunTokenClaims } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import { customAutomationHistoryAccess } from '../custom-automation-history-access';

// Run binding is independent of mutable actingUserId. Retain the authenticated
// principal as well so history reads can distinguish human and deployment runs.
type ArtifactRouteAuthContext = RunTokenContext;

type ArtifactRouteAuthResult =
  | { ok: true; auth: ArtifactRouteAuthContext }
  | { ok: false; status: 401 | 403; error: string };

type ArtifactRouteTaskBindingResult =
  | { ok: true }
  | { ok: false; status: 403; error: string };

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

export function resolveArtifactRouteAuth(
  auth: Variables['authContext'],
): ArtifactRouteAuthResult {
  if (!auth) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
    };
  }

  if (isRunTokenContext(auth)) {
    return {
      ok: true,
      auth,
    };
  }

  return {
    ok: false,
    status: 403,
    error: 'Artifact API is only available for task run tokens',
  };
}

async function getArtifactRouteTaskRunBinding(auth: ArtifactRouteAuthContext) {
  const scopedRun = await findTaskRunByRunTokenClaims(auth);
  if (!scopedRun) {
    return null;
  }

  return db.query.taskRuns.findFirst({
    columns: {
      taskId: true,
    },
    where: eq(taskRuns.id, scopedRun.id),
  });
}

export async function verifyArtifactRouteTaskBinding(
  taskId: string,
  auth: ArtifactRouteAuthContext,
): Promise<ArtifactRouteTaskBindingResult> {
  const taskRun = await getArtifactRouteTaskRunBinding(auth);

  if (!taskRun || taskRun.taskId !== taskId) {
    return {
      ok: false,
      status: 403,
      error: 'Task run token does not match requested task',
    };
  }

  return { ok: true };
}

const TASK_READ_ACCESS_DENIED: ArtifactRouteTaskBindingResult = {
  ok: false,
  status: 403,
  error: 'Task run token does not grant read access to requested task',
};

/**
 * Verify that the calling task run may read artifacts for the requested
 * task. Unlike the strict write-path binding above, reads are also allowed
 * for other visible tasks the caller can access, matching the history access
 * that MCP task routes (summary, messages, search) grant to task run
 * tokens. This lets an agent consume artifacts produced by earlier tasks
 * (for example downloading a plan artifact published by a planning task).
 * Artifact writes stay bound to the job's own task.
 */
export async function verifyArtifactRouteTaskReadAccess(
  taskId: string,
  auth: ArtifactRouteAuthContext,
): Promise<ArtifactRouteTaskBindingResult> {
  const taskRun = await getArtifactRouteTaskRunBinding(auth);

  if (!taskRun) {
    return TASK_READ_ACCESS_DENIED;
  }

  const requestedTask = await db.query.tasks.findFirst({
    columns: {
      id: true,
    },
    where: and(
      eq(tasks.id, taskId),
      taskRun.taskId === taskId ? undefined : isVisibleTask(),
      customAutomationHistoryAccess(
        { userId: auth.userId ?? undefined, authContext: auth },
        'task',
      ),
    ),
  });

  if (requestedTask) {
    return { ok: true };
  }

  return TASK_READ_ACCESS_DENIED;
}
