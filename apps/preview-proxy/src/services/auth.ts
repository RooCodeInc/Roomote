import * as redis from '../lib/redis';
import { logger } from '../lib/logger';
import { validatePreviewToken } from '@roomote/auth';
import type { PreviewTokenContext } from '@roomote/types';
import type { CloudJob } from '@roomote/db';

// Backward compatibility wrapper for validateToken
export async function validateToken(
  token: string,
): Promise<PreviewTokenContext | null> {
  try {
    return await validatePreviewToken(token);
  } catch (error) {
    logger.debug({ error }, 'Error validating token');
    return null;
  }
}

export async function storeState(
  state: string,
  redirectUri: string,
  cloudJobId: number,
): Promise<void> {
  const data = JSON.stringify({
    redirectUri,
    cloudJobId,
    createdAt: Date.now(),
  });
  await redis.setWithExpiry(`preview:state:${state}`, data, 600);
}

export async function validateState(
  state: string,
): Promise<{ redirectUri: string; cloudJobId: number } | null> {
  const data = await redis.get(`preview:state:${state}`);

  if (!data) {
    return null;
  }

  await redis.del(`preview:state:${state}`);

  try {
    const parsed = JSON.parse(data);
    return { redirectUri: parsed.redirectUri, cloudJobId: parsed.cloudJobId };
  } catch {
    return null;
  }
}

interface AuthValidationResult {
  valid: boolean;
  token?: PreviewTokenContext;
  taskId?: string;
  reason?: 'missing' | 'invalid' | 'job_not_found';
}

/**
 * Validate an auth cookie against a known CloudJob.
 * This avoids repeating DB lookups when the caller already has the job.
 */
export async function validateAuthCookieForCloudJob(
  authCookie: string | undefined,
  cloudJob: CloudJob,
): Promise<AuthValidationResult> {
  const taskId = cloudJob.taskId ?? undefined;

  if (!authCookie) {
    return { valid: false, reason: 'missing', taskId };
  }

  try {
    const token = await validatePreviewToken(authCookie);
    if (!token) {
      return { valid: false, reason: 'invalid', taskId };
    }

    return { valid: true, token, taskId };
  } catch (error) {
    logger.debug({ error }, 'Token validation error');
    return { valid: false, reason: 'invalid', taskId };
  }
}
