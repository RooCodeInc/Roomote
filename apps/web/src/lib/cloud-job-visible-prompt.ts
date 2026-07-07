import {
  isSystemInjectedAcpPromptText,
  normalizeTranscriptUserText,
  ACP_ENVELOPE_EVENT_TYPES,
} from '@roomote/types';

import type { CloudJobDetail } from '@/lib/server';

export interface CloudJobVisiblePrompt {
  text?: string;
  images?: string[];
  visibleInTranscript: boolean;
}

function getSnapshotResumePromptText(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): string | undefined {
  if (!cloudJob || !('resumePrompt' in cloudJob.payload)) {
    return undefined;
  }

  return typeof cloudJob.payload.resumePrompt === 'string'
    ? cloudJob.payload.resumePrompt
    : undefined;
}

function getSnapshotResumePromptImages(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): string[] | undefined {
  if (!cloudJob || !('resumePromptImages' in cloudJob.payload)) {
    return undefined;
  }

  return Array.isArray(cloudJob.payload.resumePromptImages)
    ? cloudJob.payload.resumePromptImages.filter(
        (image): image is string => typeof image === 'string',
      )
    : undefined;
}

function hasExplicitSnapshotResumePrompt(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): boolean {
  const resumePromptText = getSnapshotResumePromptText(cloudJob);
  const resumePromptImages = getSnapshotResumePromptImages(cloudJob);

  return (
    Boolean(resumePromptText?.trim()) || Boolean(resumePromptImages?.length)
  );
}

export function getCloudJobPromptText(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): string | undefined {
  if (!cloudJob) {
    return undefined;
  }

  const resumePromptText = getSnapshotResumePromptText(cloudJob);
  if (resumePromptText?.trim()) {
    return resumePromptText;
  }

  if ('description' in cloudJob.payload) {
    return cloudJob.payload.description;
  }

  if ('text' in cloudJob.payload) {
    return cloudJob.payload.text;
  }

  if ('commentBody' in cloudJob.payload) {
    return cloudJob.payload.commentBody;
  }

  return undefined;
}

function getCloudJobPromptVisibility(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
  text?: string,
): boolean {
  if (!cloudJob) {
    return true;
  }

  const explicitSnapshotResumePrompt =
    hasExplicitSnapshotResumePrompt(cloudJob);

  if (
    !explicitSnapshotResumePrompt &&
    typeof cloudJob.payload.visibleInTranscript === 'boolean'
  ) {
    return cloudJob.payload.visibleInTranscript;
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
    ('description' in cloudJob.payload || 'text' in cloudJob.payload);

  return !(
    usesCommandStylePromptField && /^(?:\/|\$)[a-z0-9-]+(?:\s|$)/i.test(trimmed)
  );
}

function getCloudJobPromptImages(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): string[] | undefined {
  if (hasExplicitSnapshotResumePrompt(cloudJob)) {
    return getSnapshotResumePromptImages(cloudJob);
  }

  if (!cloudJob || !('images' in cloudJob.payload)) {
    return undefined;
  }

  return cloudJob.payload.images;
}

/**
 * Builds a visible session prompt from the cloud job's launch payload.
 * Prompts derived from the user's original launch input are always visible;
 * the server marks harness-injected bootstrap prompts as hidden separately.
 */
export function getCloudJobVisiblePrompt(
  cloudJob: Pick<CloudJobDetail, 'payload'> | null | undefined,
): CloudJobVisiblePrompt | null {
  const text = getCloudJobPromptText(cloudJob);

  const visibleText = normalizeTranscriptUserText(
    text,
    ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  );

  const images = getCloudJobPromptImages(cloudJob);

  if (!visibleText && (!images || images.length === 0)) {
    return null;
  }

  return {
    ...(visibleText ? { text: visibleText } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    visibleInTranscript: getCloudJobPromptVisibility(cloudJob, text),
  };
}
