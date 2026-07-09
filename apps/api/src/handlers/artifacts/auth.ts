import type { JobTokenContext } from '@roomote/types';
import {
  and,
  cloudJobs,
  db,
  eq,
  isVisibleTask,
  tasks,
} from '@roomote/db/server';
import { findCloudJobByJobTokenClaims } from '@roomote/sdk/server';

import type { Variables } from '../../types';

type ArtifactRouteAuthContext = {
  /**
   * Null for deployment-principal job tokens. Authorization stays scoped to
   * the cloud job itself: `findCloudJobByJobTokenClaims` matches by
   * `cloudJobId` and only requires `userId` to agree when the job has an
   * owner, so an ownerless job's deployment token is authorized exactly like
   * the job's own user would have been.
   */
  userId: string | null;
  cloudJobId: number;
  tokenType: 'cj';
};

type ArtifactRouteAuthResult =
  | { ok: true; auth: ArtifactRouteAuthContext }
  | { ok: false; status: 401 | 403; error: string };

type ArtifactRouteTaskBindingResult =
  | { ok: true }
  | { ok: false; status: 403; error: string };

function isJobTokenContext(
  auth: Variables['authContext'],
): auth is JobTokenContext {
  return Boolean(auth && 'cloudJobId' in auth);
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

  if (isJobTokenContext(auth)) {
    return {
      ok: true,
      auth: {
        userId: auth.userId,
        cloudJobId: auth.cloudJobId,
        tokenType: 'cj',
      },
    };
  }

  return {
    ok: false,
    status: 403,
    error: 'Artifact API is only available for cloud job tokens',
  };
}

async function getArtifactRouteCloudJobBinding(auth: ArtifactRouteAuthContext) {
  const scopedJob = await findCloudJobByJobTokenClaims(auth);
  if (!scopedJob) {
    return null;
  }

  return db.query.cloudJobs.findFirst({
    columns: {
      taskId: true,
    },
    where: eq(cloudJobs.id, scopedJob.id),
  });
}

export async function verifyArtifactRouteTaskBinding(
  taskId: string,
  auth: ArtifactRouteAuthContext,
): Promise<ArtifactRouteTaskBindingResult> {
  const cloudJob = await getArtifactRouteCloudJobBinding(auth);

  if (!cloudJob || cloudJob.taskId !== taskId) {
    return {
      ok: false,
      status: 403,
      error: 'Cloud job token does not match requested task',
    };
  }

  return { ok: true };
}

const TASK_READ_ACCESS_DENIED: ArtifactRouteTaskBindingResult = {
  ok: false,
  status: 403,
  error: 'Cloud job token does not grant read access to requested task',
};

/**
 * Verify that the calling cloud job may read artifacts for the requested
 * task. Unlike the strict write-path binding above, reads are also allowed
 * for any other visible task, matching the cross-task read access that the
 * MCP task routes (summary, messages, search) already grant to cloud job
 * tokens. This lets an agent consume artifacts produced by earlier tasks
 * (for example downloading a plan artifact published by a planning task).
 * Artifact writes stay bound to the job's own task.
 */
export async function verifyArtifactRouteTaskReadAccess(
  taskId: string,
  auth: ArtifactRouteAuthContext,
): Promise<ArtifactRouteTaskBindingResult> {
  const cloudJob = await getArtifactRouteCloudJobBinding(auth);

  if (!cloudJob) {
    return TASK_READ_ACCESS_DENIED;
  }

  if (cloudJob.taskId === taskId) {
    return { ok: true };
  }

  const requestedTask = await db.query.tasks.findFirst({
    columns: {
      id: true,
    },
    where: and(eq(tasks.id, taskId), isVisibleTask(tasks.id)),
  });

  if (requestedTask) {
    return { ok: true };
  }

  return TASK_READ_ACCESS_DENIED;
}
