import type { Context } from 'hono';

import { db, eq, taskArtifacts } from '@roomote/db/server';

import type { Variables } from '../../types';
import {
  resolveArtifactRouteAuth,
  verifyArtifactRouteTaskBinding,
} from './auth';
import { getArtifactById } from './service';

export async function markArtifactUploadComplete(
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

  const taskBindingResult = await verifyArtifactRouteTaskBinding(taskId, auth);
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

  await db
    .update(taskArtifacts)
    .set({
      uploaded: true,
      updatedAt: new Date(),
    })
    .where(eq(taskArtifacts.id, artifactId));

  return new Response(null, { status: 200 });
}
