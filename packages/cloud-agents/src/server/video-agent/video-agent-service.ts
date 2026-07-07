import { formatErrorForLog } from '@roomote/types';

import {
  isVideoAgentSupportedMimeType,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from './video-agent-constants';

export async function describeVideoAttachment(input: {
  userId?: string | null;
  taskId?: string | null;
  videoBytes: Buffer;
  mimeType: string;
  userTextContext?: string;
}): Promise<string | null> {
  const startedAt = Date.now();

  if (!isVideoAgentSupportedMimeType(input.mimeType)) {
    console.warn(
      `[Video Agent] Skipping unsupported video mime type: ${input.mimeType}`,
    );
    return null;
  }

  if (input.videoBytes.length > VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES) {
    console.warn(
      `[Video Agent] Skipping video larger than ${VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES} bytes: ${input.videoBytes.length}`,
    );
    return null;
  }

  try {
    console.info(
      `[Video Agent] Skipping video description because Roomote no longer configures a separate video model provider (${Date.now() - startedAt}ms)`,
    );
    return null;
  } catch (error) {
    console.error(
      `[Video Agent] Failed to describe video after ${Date.now() - startedAt}ms: ${formatErrorForLog(
        error,
      )}`,
    );
    return null;
  }
}
