import type { IncomingMessage, ServerResponse } from 'http';
import { taskRuns, eq, and } from '@roomote/db/server';
import { validatePreviewToken } from '@roomote/auth';

import { config } from '../config';
import { db } from '../lib/db';
import { logger, escapeForLog } from '../lib/logger';

/**
 * Extract cookie value from request headers.
 */
function getCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;

  const match = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  return match ? match.slice(name.length + 1) : undefined;
}

/**
 * Handle a request to get the status of a resume task run.
 * Used by the resuming progress page to poll for completion.
 *
 * GET /api/resume-status/:resumeStatusId
 *
 * Requires a valid preview auth cookie that matches the run's org/user.
 */
export async function handleResumeStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resumeStatusId: string,
): Promise<void> {
  const sendJson = (status: number, data: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Validate auth cookie
  const authCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);
  if (!authCookie) {
    logger.debug(
      { resumeStatusId },
      'Resume status request without auth cookie',
    );
    sendJson(401, { error: 'Authentication required' });
    return;
  }

  let token;
  try {
    token = await validatePreviewToken(authCookie);
    if (!token) {
      logger.debug(
        { resumeStatusId },
        'Resume status request with invalid token',
      );
      sendJson(401, { error: 'Invalid authentication token' });
      return;
    }
  } catch (error) {
    logger.debug({ resumeStatusId, error }, 'Token validation error');
    sendJson(401, { error: 'Authentication failed' });
    return;
  }

  const runId: number | null = Number.isInteger(Number(resumeStatusId))
    ? Number(resumeStatusId)
    : null;

  if (!runId) {
    sendJson(404, { error: 'Resume item not found' });
    return;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, runId), eq(taskRuns.actingUserId, token.userId)),
    columns: {
      id: true,
      status: true,
      error: true,
      machineId: true,
    },
  });

  if (!taskRun) {
    logger.info(
      {
        runId,
        userId: escapeForLog(token.userId),
      },
      'Resume status: run not found or unauthorized',
    );
    sendJson(404, { error: 'Run not found' });
    return;
  }

  logger.debug({ runId, status: taskRun.status }, 'Resume status request');

  sendJson(200, {
    status: taskRun.status,
    error: taskRun.error ?? null,
    ready: taskRun.machineId != null,
  });
}
