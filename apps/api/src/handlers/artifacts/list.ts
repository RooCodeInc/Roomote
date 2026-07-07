import type { Context } from 'hono';
import { taskArtifactTypeSchema, type TaskArtifactType } from '@roomote/types';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from '@roomote/sdk/server';
import { Env, getArtifactSigningKey } from '@roomote/env';

import type { Variables } from '../../types';
import {
  resolveArtifactRouteAuth,
  verifyArtifactRouteTaskReadAccess,
} from './auth';
import { listArtifactsByTask } from './service';

/**
 * List a task's uploaded artifacts (latest version per path). Returns the
 * same URL shapes the create/upload response returns: a viewUrl for every
 * artifact and a signed rawUrl for image artifacts.
 */
export async function listTaskArtifacts(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  const authResult = resolveArtifactRouteAuth(c.get('authContext'));

  if (!authResult.ok) {
    return c.json({ error: authResult.error }, authResult.status);
  }
  const auth = authResult.auth;

  const taskId = c.req.param('taskId');

  if (!taskId) {
    return c.json({ error: 'Missing task ID' }, 400);
  }

  const rawArtifactType = c.req.query('artifactType');
  let artifactTypeFilter: TaskArtifactType | undefined;
  if (rawArtifactType !== undefined) {
    const parsed = taskArtifactTypeSchema.safeParse(rawArtifactType);
    if (!parsed.success) {
      return c.json({ error: 'Invalid artifactType filter' }, 400);
    }
    artifactTypeFilter = parsed.data;
  }

  const taskBindingResult = await verifyArtifactRouteTaskReadAccess(
    taskId,
    auth,
  );
  if (!taskBindingResult.ok) {
    return c.json({ error: taskBindingResult.error }, taskBindingResult.status);
  }

  const artifacts = await listArtifactsByTask({
    taskId,
    artifactType: artifactTypeFilter,
    auth: {},
  });

  const rawUrlTs = currentEpochSeconds();

  return c.json({
    taskId,
    artifacts: artifacts.map((artifact) => {
      const entry: {
        id: string;
        path: string;
        version: number;
        artifactType: string;
        contentType: string;
        size: number;
        createdAt: Date;
        viewUrl: string;
        rawUrl?: string;
      } = {
        id: artifact.id,
        path: artifact.path,
        version: artifact.version,
        artifactType: artifact.artifactType,
        contentType: artifact.contentType,
        size: artifact.size,
        createdAt: artifact.createdAt,
        viewUrl: `${Env.ROOMOTE_APP_URL}/task/${taskId}/artifacts/${artifact.path}?v=${artifact.version}`,
      };

      if (artifact.contentType.startsWith('image/')) {
        entry.rawUrl = buildSignedArtifactRawUrl({
          artifactId: artifact.id,
          ts: rawUrlTs,
          apiBaseUrl: Env.ROOMOTE_APP_URL,
          signingKey: getArtifactSigningKey(),
        });
      }

      return entry;
    }),
  });
}
