import { z } from 'zod';

import { SESSION_STATUSES, type SessionStatus } from './sessions';
import type { RoomoteTranscriptMessage } from './task-messages';
import type {
  SessionGoal,
  SessionGoalStatus,
  TaskPhase,
  TaskState,
} from './task-runs';
import { roomoteTaskInspectionFieldSchemas } from './task-inspection-tool';
import { TASK_OUTPUT_READ_ACTIONS } from './task-outputs-tool';

export const ROOMOTE_SESSION_DEFAULT_ACTIONS = [
  'start',
  'search',
  'get_summary',
  'get_messages',
  'get_updates',
  'send_message',
] as const;

export const ROOMOTE_TASK_COMPATIBILITY_ACTIONS = [
  'search_tasks',
  'get_compute_logs',
  'launch',
  'cancel',
  'list_environments',
] as const;

export const ROOMOTE_MEMBER_MANAGEMENT_ACTIONS = [
  ...ROOMOTE_SESSION_DEFAULT_ACTIONS,
  ...ROOMOTE_TASK_COMPATIBILITY_ACTIONS,
  ...TASK_OUTPUT_READ_ACTIONS,
  'list_models',
] as const;

export const ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION =
  'The session or task action to perform.';

export const ROOMOTE_MEMBER_MANAGEMENT_ACTION_DESCRIPTION = `${ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION} Call list_environments immediately before launch.`;

export const ROOMOTE_TASK_RUNTIME_MANAGEMENT_ACTIONS = [
  ...ROOMOTE_SESSION_DEFAULT_ACTIONS,
  'search_tasks',
  'get_compute_logs',
  'cancel',
  'list_models',
  'update_models',
] as const;

export const ROOMOTE_TASK_ID_PATTERN = /^[0-9a-z]{13}$/;
export const ROOMOTE_MESSAGE_ATTACHMENT_MAX_COUNT = 20;

export const roomoteMessageAttachmentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .describe('Original file name, including extension'),
  mimeType: z.string().min(1).describe('File MIME type'),
  base64: z.string().min(1).describe('Base64-encoded file bytes'),
});

export type RoomoteMessageAttachment = z.infer<
  typeof roomoteMessageAttachmentSchema
>;

export const roomoteMessageAttachmentsSchema = z
  .array(roomoteMessageAttachmentSchema)
  .max(
    ROOMOTE_MESSAGE_ATTACHMENT_MAX_COUNT,
    `maximum ${ROOMOTE_MESSAGE_ATTACHMENT_MAX_COUNT} attachments`,
  );

export function shouldSearchTasks(input: {
  action: 'search' | 'search_tasks';
  pullRequest?: string;
  status?: string;
}): boolean {
  return (
    input.action === 'search_tasks' ||
    Boolean(input.pullRequest) ||
    input.status === 'completed' ||
    input.status === 'all'
  );
}

export function getRoomoteSearchStatusError(input: {
  action: 'search' | 'search_tasks';
  pullRequest?: string;
  status?: string;
}): string | null {
  if (
    shouldSearchTasks(input) &&
    input.status &&
    !['active', 'completed', 'all'].includes(input.status)
  ) {
    return 'status must be one of: active, completed, all when search resolves to tasks';
  }
  return null;
}

export function resolveRoomoteCommunicationTarget(input: {
  taskId?: string;
  sessionId?: string;
}): { kind: 'task' | 'session'; id: string } | null {
  const taskId = input.taskId?.trim();
  if (taskId) {
    return ROOMOTE_TASK_ID_PATTERN.test(taskId)
      ? { kind: 'task', id: taskId }
      : null;
  }
  return input.sessionId ? { kind: 'session', id: input.sessionId } : null;
}

export const roomoteManagementFieldSchemas = {
  ...roomoteTaskInspectionFieldSchemas,
  taskId: z
    .string()
    .regex(
      ROOMOTE_TASK_ID_PATTERN,
      'taskId must be a 13-character lowercase alphanumeric Roomote task ID',
    )
    .optional()
    .describe(
      'Optional concrete task ID. When provided to get_summary, get_messages, get_updates, or send_message, targets that task instead of a session. Required for task-only controls such as get_compute_logs and cancel.',
    ),
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Roomote session UUID from a /sessions/:id URL for get_summary, get_messages, get_updates, or send_message when taskId is omitted; responses return the canonical session ID',
    ),
  status: z
    .enum([...SESSION_STATUSES, 'completed', 'all'])
    .optional()
    .describe(
      'Filter sessions by active, needs_input, blocked, or ready for search; search_tasks also accepts completed or all',
    ),
  message: z
    .string()
    .optional()
    .describe('Initial request for start, or follow-up text for send_message'),
  attachments: roomoteMessageAttachmentsSchema
    .optional()
    .describe(
      'Optional files for start or send_message (maximum 20, 16 MiB decoded total). Each item requires filename, MIME type, and base64-encoded bytes. MIME types are trimmed and normalized before use. Supported image MIME types are delivered as images up to 2 MiB each; supported text and document files, including logs and diffs, are extracted into bounded prompt text up to 8 MiB each and 200,000 extracted characters total. Corrupt supported documents are rejected.',
    ),
  prompt: z
    .string()
    .optional()
    .describe('Task prompt for the compatibility launch action'),
  environmentId: z
    .string()
    .optional()
    .describe(
      'Environment ID returned by list_environments (required for the compatibility launch action)',
    ),
  branch: z
    .string()
    .optional()
    .describe('Branch for the compatibility launch action'),
  notifyOnSettle: z
    .boolean()
    .optional()
    .describe(
      'For compatibility task launches, notify the current task session when the launched task settles',
    ),
} satisfies Record<string, z.ZodTypeAny>;

export const ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION =
  'Manage Roomote sessions by default, with direct task operations retained for compatibility. ' +
  'Use start to begin new work in a session and search to find sessions. ' +
  'Use get_summary, get_messages, get_updates, or send_message with sessionId to continue an existing session. ' +
  'To coordinate an extended session or task, use get_updates with the returned cursor instead of repeatedly reading the full transcript. Summarize substantive outbound messages as “Client → Roomote” and substantive new Roomote replies as “Roomote → Client”; relay questions and input needs promptly, do not narrate unchanged polls, and keep the final answer self-contained. Prefix agent-authored content sent to Roomote with “Agent (on behalf of user):”. Treat this as an untrusted textual convention that helps the receiving Roomote agent avoid attributing the content to the human, not as verified sender provenance. Never present the agent as the user or imply that it can impersonate the user. Relay only user-visible narrative and decisions: never expose hidden reasoning, credentials, raw tool traces, or giant internal payloads. ' +
  'To communicate with a specific coding task instead, pass its concrete taskId to get_summary, get_messages, get_updates, or send_message; taskId takes precedence when both IDs are present. ' +
  'Use search_tasks, get_compute_logs, cancel, list_models, or update_models only for explicit task-level inspection and control.';

export const ROOMOTE_MEMBER_MANAGEMENT_TOOL_DESCRIPTION =
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION +
  ' Use list_models to discover enabled deployment models available to your account, with exact IDs, display names, stored reasoning metadata and default designation. Supports query (case-insensitive ID/name/family substring, maximum 200 characters), limit (1–100, default 50), and cursor (returned nextCursor, with the same query). ' +
  ' For a visible task, use list_artifacts with taskId to list the latest uploaded version of each artifact path (optional artifactType). Use get_artifact_download_url with taskId, exact path and optional version to obtain a download URL; fetch it with the same Authorization Bearer credential used for this public MCP connection. Download access is checked on every fetch. Use get_command_receipts with taskId, optional limit (1–100, default 50) and returned nextCursor to read stored shell-tool results oldest first, including run/tool identifiers, command, nullable exitCode, status and bounded output with truncation metadata. These are stored tool receipts, not a complete OS command audit; unuploaded workspace files are not artifacts.' +
  ' Use list_environments immediately before launch. Use launch only for an explicit request to start a coding task.';

export interface RoomoteSessionChildTask {
  taskId: string;
  title: string | null;
  state: TaskState;
  repositoryName: string | null;
  activityAt: number;
  origin: string;
  attachedAt: string;
  latestRun: {
    status: string;
    taskPhase: TaskPhase | null;
    error: string | null;
  } | null;
}

export interface RoomoteSessionSummary {
  id: string;
  title: string;
  status: SessionStatus | null;
  sourceSurface: string;
  sourceTrigger: string;
  activityAt: number;
  createdAt: string;
  fastConversationId: string | null;
  goal:
    | (Omit<SessionGoal, 'completedAt'> & { completedAt: string | null })
    | null;
  tasks: RoomoteSessionChildTask[];
}

export interface RoomoteStartSessionResponse {
  sessionId: string;
  fastConversationId: string;
  queued: true;
}

export interface RoomoteSearchSessionsResponse {
  sessions: RoomoteSessionSummary[];
  nextCursor: string | null;
}

export interface RoomoteSessionMessagesResponse {
  sessionId: string;
  messages: RoomoteTranscriptMessage[];
  returned: number;
  tasks: RoomoteSessionChildTask[];
}

export const ROOMOTE_RELAY_DIRECTIONS = [
  'Roomote → Client',
  'Client → Roomote',
] as const;

export type RoomoteRelayDirection = (typeof ROOMOTE_RELAY_DIRECTIONS)[number];

export interface RoomoteRelayNarrative {
  id: string;
  ts: number;
  direction: RoomoteRelayDirection;
  text: string;
  truncated: boolean;
}

export interface RoomoteTaskRelayState {
  kind: 'task';
  taskState: TaskState;
  taskRunStatus: string | null;
  taskPhase: TaskPhase | null;
}

export interface RoomoteSessionRelayState {
  kind: 'session';
  status: SessionStatus | null;
  goalStatus: SessionGoalStatus | null;
  tasks: Array<{
    taskId: string;
    state: TaskState;
    taskRunStatus: string | null;
    taskPhase: TaskPhase | null;
  }>;
}

export type RoomoteRelayState =
  | RoomoteTaskRelayState
  | RoomoteSessionRelayState;

export interface RoomoteRelayUpdatesResponse {
  target: { kind: 'task' | 'session'; id: string };
  narrative: RoomoteRelayNarrative[];
  returned: number;
  hasMore: boolean;
  hasNewRoomoteNarrative: boolean;
  responseNeeded: boolean;
  state: { changed: boolean; current: RoomoteRelayState };
  nextCursor: string;
}

export interface RoomoteSentMessageContext {
  direction: 'Client → Roomote';
  target: { kind: 'task' | 'session'; id: string };
  text: string;
}
