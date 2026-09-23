import { formatErrorForLog } from '@roomote/types';

import {
  generateTrackedNonTaskText,
  isNonTaskAudioVideoCapabilityError,
  NonTaskAudioVideoSupportDisabledError,
  NonTaskInputModalityUnsupportedError,
  NON_TASK_INFERENCE_SURFACES,
  VISION_MODEL_AUDIO_VIDEO_DISABLED_MESSAGE,
} from '../non-task-provider-usage';
import {
  isVideoAgentSupportedMimeType,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from './video-agent-constants';
import {
  buildVideoAgentUserPrompt,
  VIDEO_AGENT_SYSTEM_PROMPT,
} from './video-agent-prompt';

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
    const description = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.chatVideoDescription,
      userId: input.userId,
      taskId: input.taskId,
      requiredInputModality: 'video',
      system: VIDEO_AGENT_SYSTEM_PROMPT,
      prompt: buildVideoAgentUserPrompt({
        userTextContext: input.userTextContext,
      }),
      files: [
        {
          mime: input.mimeType,
          url: `data:${input.mimeType};base64,${input.videoBytes.toString('base64')}`,
        },
      ],
    });

    console.info(
      `[Video Agent] Described video in ${Date.now() - startedAt}ms`,
    );
    return description;
  } catch (error) {
    if (error instanceof NonTaskAudioVideoSupportDisabledError) {
      return VISION_MODEL_AUDIO_VIDEO_DISABLED_MESSAGE;
    }
    if (
      error instanceof NonTaskInputModalityUnsupportedError ||
      isNonTaskAudioVideoCapabilityError(error, 'video')
    ) {
      console.warn(
        `[Video Agent] Skipping video description: the Vision model does not support video input. Choose a video-capable model under Settings > Models > Vision model (${Date.now() - startedAt}ms)`,
      );
      return 'The Vision model does not support video input. Choose a video-capable model under Settings > Models > Vision model.';
    }

    console.error(
      `[Video Agent] Failed to describe video after ${Date.now() - startedAt}ms: ${formatErrorForLog(
        error,
      )}`,
    );
    return null;
  }
}
