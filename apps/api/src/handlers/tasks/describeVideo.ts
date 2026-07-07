import type { Context } from 'hono';
import {
  describeVideoAttachment,
  isVideoAgentSupportedMimeType,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from '@roomote/cloud-agents/server';
import { and, db, eq, tasks } from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import { visibleTaskHistoryCondition } from './helpers';

type DescribeVideoBody = {
  videoBytes?: string;
  mimeType?: string;
  userTextContext?: string;
};

class RequestBodyTooLargeError extends Error {}

const MAX_BASE64_VIDEO_LENGTH =
  4 * Math.ceil(VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES / 3);
const MAX_DESCRIBE_VIDEO_REQUEST_BYTES = MAX_BASE64_VIDEO_LENGTH + 256 * 1024;

function normalizeOptionalString(
  value: FormDataEntryValue | undefined,
): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

async function readRequestBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError();
    }

    chunks.push(value);
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bodyBytes;
}

async function parseDescribeVideoBody(
  contentType: string,
  bodyBytes: Uint8Array,
): Promise<DescribeVideoBody | null> {
  if (contentType.includes('multipart/form-data')) {
    const formData = await new Request('http://roomote.local/describe_video', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Blob([Buffer.from(bodyBytes)]),
    }).formData();

    return {
      videoBytes: normalizeOptionalString(
        formData.get('videoBytes') ?? undefined,
      ),
      mimeType: normalizeOptionalString(formData.get('mimeType') ?? undefined),
      userTextContext: normalizeOptionalString(
        formData.get('userTextContext') ?? undefined,
      ),
    };
  }

  return JSON.parse(new TextDecoder().decode(bodyBytes)) as DescribeVideoBody;
}

function getContentLength(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): number | null {
  const headerValue = c.req.header('content-length');
  if (!headerValue) {
    return null;
  }

  const parsedLength = Number(headerValue);
  if (!Number.isFinite(parsedLength) || parsedLength < 0) {
    return null;
  }

  return parsedLength;
}

function estimateDecodedBase64Bytes(base64: string): number {
  const normalized = base64.trim().replace(/\s+/g, '');
  if (!normalized) {
    return 0;
  }

  const padding = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;

  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

/**
 * POST /api/tasks/:taskId/describe_video
 *
 * Describe a task-local video attachment without exposing the API key to the sandbox.
 */
export async function describeVideo(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  const contentLength = getContentLength(c);
  if (
    contentLength !== null &&
    contentLength > MAX_DESCRIBE_VIDEO_REQUEST_BYTES
  ) {
    return c.json(
      {
        error: `Request body exceeds max size of ${MAX_DESCRIBE_VIDEO_REQUEST_BYTES} bytes`,
      },
      413,
    );
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), visibleTaskHistoryCondition),
      columns: { id: true },
    });

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }
  } catch (error) {
    logHandlerError('describeVideo', error);
    return c.json({ error: 'Failed to describe video' }, 500);
  }

  let body: DescribeVideoBody | null;

  try {
    const bodyBytes = await readRequestBodyBytes(
      c.req.raw,
      MAX_DESCRIBE_VIDEO_REQUEST_BYTES,
    );
    const contentType = c.req.header('content-type') ?? '';

    body = await parseDescribeVideoBody(contentType, bodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json(
        {
          error: `Request body exceeds max size of ${MAX_DESCRIBE_VIDEO_REQUEST_BYTES} bytes`,
        },
        413,
      );
    }

    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (!body?.videoBytes?.trim()) {
    return c.json({ error: 'videoBytes is required' }, 400);
  }

  if (!body.mimeType?.trim()) {
    return c.json({ error: 'mimeType is required' }, 400);
  }

  if (!isVideoAgentSupportedMimeType(body.mimeType)) {
    return c.json(
      { error: `Unsupported video mimeType: ${body.mimeType}` },
      400,
    );
  }

  if (
    estimateDecodedBase64Bytes(body.videoBytes) >
    VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES
  ) {
    return c.json(
      {
        error: `Video exceeds max size of ${VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES} bytes`,
      },
      413,
    );
  }

  const videoBytes = Buffer.from(body.videoBytes, 'base64');

  if (videoBytes.length === 0) {
    return c.json(
      { error: 'videoBytes must be valid base64-encoded data' },
      400,
    );
  }

  if (videoBytes.length > VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES) {
    return c.json(
      {
        error: `Video exceeds max size of ${VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES} bytes`,
      },
      413,
    );
  }

  try {
    const description = await describeVideoAttachment({
      userId: auth.userId,
      taskId,
      videoBytes,
      mimeType: body.mimeType,
      ...(body.userTextContext?.trim()
        ? { userTextContext: body.userTextContext.trim() }
        : {}),
    });

    if (!description) {
      return c.json({ error: 'Failed to describe video' }, 502);
    }

    return c.json({ description });
  } catch (error) {
    logHandlerError('describeVideo', error);
    return c.json({ error: 'Failed to describe video' }, 500);
  }
}
