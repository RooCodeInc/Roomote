import type { Context } from 'hono';
import {
  type ReservedTaskArtifactType,
  resolveCreateArtifactType,
} from '@roomote/types';

import {
  buildSignedArtifactRawUrl,
  createTaskArtifactRecord,
  currentEpochSeconds,
} from '@roomote/sdk/server';
import { Env, getArtifactSigningKey } from '@roomote/env';

import type { Variables } from '../../types';
import {
  resolveArtifactRouteAuth,
  verifyArtifactRouteTaskBinding,
} from './auth';
import {
  validateArtifactPath,
  validateArtifactSize,
  verifyTaskAccessForArtifact,
} from './service';
import {
  generateUploadUrl,
  resolveArtifactPresignEndpointForRequest,
} from './storage';

async function createArtifactRecord(
  c: Context<{ Variables: Variables }>,
  options: {
    forcedArtifactType?: ReservedTaskArtifactType;
  } = {},
): Promise<Response> {
  const authResult = resolveArtifactRouteAuth(c.get('authContext'));

  if (!authResult.ok) {
    return c.json({ error: authResult.error }, authResult.status);
  }
  const auth = authResult.auth;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { taskId, contentType, path, size } = body as Record<string, unknown>;

  if (typeof taskId !== 'string') {
    return c.json({ error: 'Missing or invalid taskId' }, 400);
  }

  if (typeof contentType !== 'string') {
    return c.json({ error: 'Missing or invalid contentType' }, 400);
  }

  if (typeof path !== 'string') {
    return c.json({ error: 'Missing or invalid path' }, 400);
  }

  if (typeof size !== 'number') {
    return c.json({ error: 'Missing or invalid size' }, 400);
  }

  const artifactTypeResult = resolveCreateArtifactType({
    rawArtifactType: (body as Record<string, unknown>).artifactType,
    forcedArtifactType: options.forcedArtifactType,
  });
  if (!artifactTypeResult.success) {
    return c.json({ error: artifactTypeResult.error }, 400);
  }
  const artifactType = artifactTypeResult.artifactType;

  const pathValidation = validateArtifactPath(path);
  if (!pathValidation.valid) {
    return c.json({ error: pathValidation.error }, 400);
  }

  const sizeValidation = validateArtifactSize(size);
  if (!sizeValidation.valid) {
    return c.json({ error: sizeValidation.error }, 400);
  }

  const taskBindingResult = await verifyArtifactRouteTaskBinding(taskId, auth);
  if (!taskBindingResult.ok) {
    return c.json({ error: taskBindingResult.error }, taskBindingResult.status);
  }

  const hasAccess = await verifyTaskAccessForArtifact(taskId, {});

  if (!hasAccess) {
    return c.json({ error: 'Task not found or access denied' }, 404);
  }

  const artifact = await createTaskArtifactRecord({
    taskId,
    runId: auth.runId ?? null,
    artifactType,
    contentType,
    path,
    size,
  });

  if (!artifact) {
    return c.json({ error: 'Failed to create artifact record' }, 500);
  }

  const uploadUrl = await generateUploadUrl(
    taskId,
    artifact.id,
    path,
    artifact.version,
    contentType,
    size,
    {
      presignEndpoint: resolveArtifactPresignEndpointForRequest(
        c.req.header('host'),
      ),
    },
  );

  const artifactUrlBase = Env.R_PUBLIC_URL ?? Env.R_APP_URL;
  const viewUrl = `${artifactUrlBase}/task/${taskId}/artifacts/${path}?v=${artifact.version}`;
  const response: {
    id: string;
    version: number;
    uploadUrl: string;
    viewUrl: string;
    artifactType: string;
    rawUrl?: string;
  } = {
    id: artifact.id,
    version: artifact.version,
    uploadUrl,
    viewUrl,
    artifactType: artifact.artifactType,
  };

  if (contentType.startsWith('image/')) {
    response.rawUrl = buildSignedArtifactRawUrl({
      artifactId: artifact.id,
      ts: currentEpochSeconds(),
      apiBaseUrl: artifactUrlBase,
      signingKey: getArtifactSigningKey(),
    });
  }

  return c.json(response);
}

export async function createArtifact(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  return createArtifactRecord(c);
}

export async function createPlanArtifact(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  return createArtifactRecord(c, { forcedArtifactType: 'plan' });
}

export async function createVisualProofArtifact(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  return createArtifactRecord(c, { forcedArtifactType: 'visual-proof' });
}
