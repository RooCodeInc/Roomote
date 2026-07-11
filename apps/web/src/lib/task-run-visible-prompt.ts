import {
  isSystemInjectedAcpPromptText,
  normalizeTranscriptUserText,
  ACP_ENVELOPE_EVENT_TYPES,
} from '@roomote/types';

import type { TaskRunDetail } from '@/lib/server';

export interface TaskRunVisiblePrompt {
  text?: string;
  images?: string[];
  visibleInTranscript: boolean;
}

function getSnapshotResumePromptText(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): string | undefined {
  if (!taskRun || !('resumePrompt' in taskRun.payload)) {
    return undefined;
  }

  return typeof taskRun.payload.resumePrompt === 'string'
    ? taskRun.payload.resumePrompt
    : undefined;
}

function getSnapshotResumePromptImages(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): string[] | undefined {
  if (!taskRun || !('resumePromptImages' in taskRun.payload)) {
    return undefined;
  }

  return Array.isArray(taskRun.payload.resumePromptImages)
    ? taskRun.payload.resumePromptImages.filter(
        (image): image is string => typeof image === 'string',
      )
    : undefined;
}

function hasExplicitSnapshotResumePrompt(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): boolean {
  const resumePromptText = getSnapshotResumePromptText(taskRun);
  const resumePromptImages = getSnapshotResumePromptImages(taskRun);

  return (
    Boolean(resumePromptText?.trim()) || Boolean(resumePromptImages?.length)
  );
}

export function getTaskRunPromptText(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): string | undefined {
  if (!taskRun) {
    return undefined;
  }

  const resumePromptText = getSnapshotResumePromptText(taskRun);
  if (resumePromptText?.trim()) {
    return resumePromptText;
  }

  if ('description' in taskRun.payload) {
    return taskRun.payload.description;
  }

  if ('text' in taskRun.payload) {
    return taskRun.payload.text;
  }

  if ('commentBody' in taskRun.payload) {
    return taskRun.payload.commentBody;
  }

  return undefined;
}

function getTaskRunPromptVisibility(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
  text?: string,
): boolean {
  if (!taskRun) {
    return true;
  }

  const explicitSnapshotResumePrompt = hasExplicitSnapshotResumePrompt(taskRun);

  if (
    !explicitSnapshotResumePrompt &&
    typeof taskRun.payload.visibleInTranscript === 'boolean'
  ) {
    return taskRun.payload.visibleInTranscript;
  }

  const trimmed = text?.trim();

  if (!trimmed) {
    return true;
  }

  if (isSystemInjectedAcpPromptText(trimmed)) {
    return false;
  }

  const usesCommandStylePromptField =
    !explicitSnapshotResumePrompt &&
    ('description' in taskRun.payload || 'text' in taskRun.payload);

  return !(
    usesCommandStylePromptField && /^(?:\/|\$)[a-z0-9-]+(?:\s|$)/i.test(trimmed)
  );
}

function getTaskRunPromptImages(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): string[] | undefined {
  if (hasExplicitSnapshotResumePrompt(taskRun)) {
    return getSnapshotResumePromptImages(taskRun);
  }

  if (!taskRun || !('images' in taskRun.payload)) {
    return undefined;
  }

  return taskRun.payload.images;
}

/**
 * Builds a visible session prompt from the task run's launch payload.
 * Prompts derived from the user's original launch input are always visible;
 * the server marks harness-injected bootstrap prompts as hidden separately.
 */
export function getTaskRunVisiblePrompt(
  taskRun: Pick<TaskRunDetail, 'payload'> | null | undefined,
): TaskRunVisiblePrompt | null {
  const text = getTaskRunPromptText(taskRun);

  const visibleText = normalizeTranscriptUserText(
    text,
    ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  );

  const images = getTaskRunPromptImages(taskRun);

  if (!visibleText && (!images || images.length === 0)) {
    return null;
  }

  return {
    ...(visibleText ? { text: visibleText } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    visibleInTranscript: getTaskRunPromptVisibility(taskRun, text),
  };
}
