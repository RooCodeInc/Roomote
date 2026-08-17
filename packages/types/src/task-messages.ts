import { asBoolean } from './primitives';
import type { SourceControlProvider } from './source-control';

export const ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL = 'roomote_runtime' as const;

export const TASK_MESSAGE_PROTOCOLS = [
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
] as const;

// OpenCode-backed task messages use Roomote-native runtime event names.
export type TaskMessageEventType = `roomote_runtime.${string}`;

export type TaskMessageRole = 'user' | 'assistant' | 'system' | 'tool' | null;

export type TaskMessageProtocol = (typeof TASK_MESSAGE_PROTOCOLS)[number];

export interface McpContentAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
}

export interface McpTextContentBlock {
  type: 'text';
  text: string;
  annotations?: McpContentAnnotations;
}

export interface McpImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
  annotations?: McpContentAnnotations;
}

export interface McpAudioContentBlock {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: McpContentAnnotations;
}

export interface McpEmbeddedResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  size?: number;
}

export interface McpResourceContentBlock {
  type: 'resource';
  resource: McpEmbeddedResource;
  annotations?: McpContentAnnotations;
}

export interface McpResourceLinkContentBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: McpContentAnnotations;
}

export type McpContentBlock =
  | McpTextContentBlock
  | McpImageContentBlock
  | McpAudioContentBlock
  | McpResourceContentBlock
  | McpResourceLinkContentBlock;

export type TaskMessageContentBlock =
  | McpContentBlock
  | {
      type: string;
      [key: string]: unknown;
    };

export type TaskMessageMetadata = Record<string, unknown>;

export type TaskMessagePayload = Record<string, unknown>;

export interface TaskMessageEnvelopeCore {
  eventType: TaskMessageEventType;
  contentBlocks?: TaskMessageContentBlock[] | null;
  metadata?: TaskMessageMetadata | null;
  payload?: TaskMessagePayload | null;
}

export const TRANSCRIPT_VISIBILITY_METADATA_KEY = 'visibleInTranscript';

/**
 * `metadata.source` value for transcript messages that a background job
 * posted on the agent's behalf (PR review-feedback notifications). These rows
 * are written directly to task history without ever entering the harness
 * session, so follow-up turns must re-surface them explicitly.
 */
export const PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE =
  'pr_review_notification';

export type PrReviewNotificationActionStatus =
  | 'pending'
  | 'processing'
  | 'resolved'
  | 'auto_resolved'
  | 'dismissed';

export const PR_REVIEW_ACTION_PROCESSING_LEASE_MS = 5 * 60 * 1000;

export interface PrReviewNotificationAction {
  taskId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  sourceControlProvider: SourceControlProvider;
  question: string;
  followUpPrompt: string;
  status: PrReviewNotificationActionStatus;
  processingStartedAt?: number;
  processingToken?: string;
}

export function getPrReviewNotificationAction(
  payload: Record<string, unknown> | null | undefined,
): PrReviewNotificationAction | null {
  const action = payload?.prReviewAction;

  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return null;
  }

  const value = action as Record<string, unknown>;
  const status = value.status;

  if (
    typeof value.taskId !== 'string' ||
    typeof value.repository !== 'string' ||
    typeof value.prNumber !== 'number' ||
    typeof value.prUrl !== 'string' ||
    !['github', 'gitlab', 'gitea', 'ado', 'bitbucket'].includes(
      typeof value.sourceControlProvider === 'string'
        ? value.sourceControlProvider
        : '',
    ) ||
    typeof value.question !== 'string' ||
    typeof value.followUpPrompt !== 'string' ||
    (value.processingStartedAt !== undefined &&
      typeof value.processingStartedAt !== 'number') ||
    (value.processingToken !== undefined &&
      typeof value.processingToken !== 'string') ||
    ![
      'pending',
      'processing',
      'resolved',
      'auto_resolved',
      'dismissed',
    ].includes(typeof status === 'string' ? status : '')
  ) {
    return null;
  }

  return value as unknown as PrReviewNotificationAction;
}

/**
 * `metadata.source` value for transcript messages that record a linked pull
 * request terminal status change (merged / closed). Written directly to task
 * history without entering the harness session, so the next agent turn can
 * re-surface them the same way as PR review-feedback notifications.
 */
export const PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE =
  'pr_status_notification';

/**
 * `metadata.source` value for the provider-posted task kickoff/started message
 * (including free-form router kickoffs). Written directly to task history so
 * the chat transcript keeps a durable copy without entering the harness
 * session as an agent turn.
 */
export const TASK_KICKOFF_MESSAGE_SOURCE = 'task_kickoff';

/**
 * All `metadata.source` values that mark a transcript message as out-of-band
 * (persisted to task history without entering the harness session).
 */
export const OUT_OF_BAND_TASK_MESSAGE_SOURCES = [
  PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE,
  PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
  TASK_KICKOFF_MESSAGE_SOURCE,
] as const;

/**
 * Out-of-band sources that should be re-surfaced into later agent prompts.
 * Kickoff messages are history-only: the worker already knows one was posted
 * via launch payload, so re-injection would only add start-of-turn noise.
 */
export const RESURFACE_OUT_OF_BAND_TASK_MESSAGE_SOURCES = [
  PR_REVIEW_NOTIFICATION_TASK_MESSAGE_SOURCE,
  PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
] as const;

/**
 * Metadata key stamped on an out-of-band transcript message once it has been
 * re-surfaced into a delivered prompt, so later turns do not inject it again.
 */
export const OUT_OF_BAND_RESURFACED_AT_METADATA_KEY = 'outOfBandResurfacedAt';

export function isVisibleInTranscript(
  metadata: TaskMessageMetadata | null | undefined,
): boolean {
  const visibleInTranscript = asBoolean(
    metadata?.[TRANSCRIPT_VISIBILITY_METADATA_KEY],
  );

  return visibleInTranscript ?? true;
}

export function withTranscriptVisibility(
  metadata: TaskMessageMetadata | null | undefined,
  visibleInTranscript: boolean | undefined,
): TaskMessageMetadata | null {
  if (visibleInTranscript === undefined) {
    return metadata ?? null;
  }

  return {
    ...(metadata ?? {}),
    [TRANSCRIPT_VISIBILITY_METADATA_KEY]: visibleInTranscript,
  };
}

export function getTextFromContentBlocks(
  blocks: TaskMessageContentBlock[] | null | undefined,
): string | null {
  if (!blocks || blocks.length === 0) {
    return null;
  }

  const textParts = blocks
    .map((block) => {
      if (block.type !== 'text') {
        return null;
      }

      return typeof block.text === 'string' ? block.text : null;
    })
    .filter((part): part is string => !!part);

  if (textParts.length === 0) {
    return null;
  }

  return textParts.join('\n');
}

export function getImageUrisFromContentBlocks(
  blocks: TaskMessageContentBlock[] | null | undefined,
): string[] {
  if (!blocks || blocks.length === 0) {
    return [];
  }

  const images: string[] = [];

  for (const block of blocks) {
    if (block.type === 'image') {
      if (
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string'
      ) {
        images.push(`data:${block.mimeType};base64,${block.data}`);
      }

      continue;
    }

    if (block.type === 'resource_link' && typeof block.uri === 'string') {
      images.push(block.uri);
    }
  }

  return images;
}
