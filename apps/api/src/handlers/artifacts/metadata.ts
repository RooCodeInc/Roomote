import type { Context } from 'hono';

import type { Variables } from '../../types';
import {
  resolveArtifactRouteAuth,
  verifyArtifactRouteTaskReadAccess,
} from './auth';
import { getArtifactByPath } from './service';

export async function getArtifactMetadataByPath(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  const authResult = resolveArtifactRouteAuth(c.get('authContext'));

  if (!authResult.ok) {
    return c.json({ error: authResult.error }, authResult.status);
  }
  const auth = authResult.auth;

  const taskId = c.req.param('taskId');
  const path = c.req.param('path');
  const versionParam = c.req.query('v');
  const version = versionParam ? Number.parseInt(versionParam, 10) : undefined;

  if (!taskId) {
    return c.json({ error: 'Missing task ID' }, 400);
  }

  if (!path) {
    return c.json({ error: 'Missing path' }, 400);
  }

  const taskBindingResult = await verifyArtifactRouteTaskReadAccess(
    taskId,
    auth,
  );
  if (!taskBindingResult.ok) {
    return c.json({ error: taskBindingResult.error }, taskBindingResult.status);
  }

  const artifact = await getArtifactByPath({
    taskId,
    path,
    version,
    auth: {},
  });

  if (!artifact) {
    return c.json({ error: 'Artifact not found or access denied' }, 404);
  }

  return c.json({
    id: artifact.id,
    taskId: artifact.taskId,
    runId: artifact.runId,
    path: artifact.path,
    version: artifact.version,
    artifactType: artifact.artifactType,
    contentType: artifact.contentType,
    size: artifact.size,
    uploaded: artifact.uploaded,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
}
