import type { Context } from 'hono';

import type { Variables } from '../../types';
import {
  resolveArtifactRouteAuth,
  verifyArtifactRouteTaskReadAccess,
} from './auth';
import { getArtifactById } from './service';
import {
  generateDownloadUrl,
  resolveArtifactPresignEndpointForRequest,
} from './storage';

export async function getArtifactDownloadUrl(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  const authResult = resolveArtifactRouteAuth(c.get('authContext'));

  if (!authResult.ok) {
    return c.json({ error: authResult.error }, authResult.status);
  }
  const auth = authResult.auth;

  const artifactId = c.req.param('id');
  if (!artifactId) {
    return c.json({ error: 'Missing artifact ID' }, 400);
  }

  const taskId = c.req.query('taskId');
  if (!taskId) {
    return c.json({ error: 'Missing taskId query parameter' }, 400);
  }

  const taskBindingResult = await verifyArtifactRouteTaskReadAccess(
    taskId,
    auth,
  );
  if (!taskBindingResult.ok) {
    return c.json({ error: taskBindingResult.error }, taskBindingResult.status);
  }

  const artifact = await getArtifactById({
    taskId,
    artifactId,
    auth: {},
  });

  if (!artifact) {
    return c.json({ error: 'Artifact not found or access denied' }, 404);
  }

  if (!artifact.uploaded) {
    return c.json({ error: 'Artifact has not been uploaded yet' }, 400);
  }

  const url = await generateDownloadUrl(
    artifact.taskId,
    artifact.id,
    artifact.path,
    artifact.version,
    {
      presignEndpoint: resolveArtifactPresignEndpointForRequest(
        c.req.header('host'),
      ),
    },
  );

  return c.json({
    url,
    path: artifact.path,
    version: artifact.version,
    contentType: artifact.contentType,
    size: artifact.size,
  });
}
