import { z } from 'zod';

import { SESSION_STATUSES, type SessionStatus } from './sessions';
import type { RoomoteTranscriptMessage } from './task-messages';
import type { TaskGoalStatus, TaskPhase, TaskState } from './task-runs';
import { roomoteTaskInspectionFieldSchemas } from './task-inspection-tool';

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
] as const;

export const ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION =
  'The Session or task action to perform. Call list_environments immediately before launch.';

export const ROOMOTE_TASK_ID_PATTERN = /^[0-9a-z]{13}$/;

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
      'Optional concrete task ID. When provided to get_summary, get_messages, get_updates, or send_message, targets that task instead of a Session. Required for task-only controls such as get_compute_logs and cancel.',
    ),
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Roomote Session UUID from a /sessions/:id URL for get_summary, get_messages, get_updates, or send_message when taskId is omitted; responses return the canonical Session ID',
    ),
  status: z
    .enum([...SESSION_STATUSES, 'completed', 'all'])
    .optional()
    .describe(
      'Filter Sessions by active, needs_input, blocked, or ready for search; search_tasks also accepts completed or all',
    ),
  message: z
    .string()
    .optional()
    .describe('Initial request for start, or follow-up text for send_message'),
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
  'Manage Roomote Sessions by default, with direct task operations retained for compatibility. ' +
  'Use start to begin new work in a Session and search to find Sessions. ' +
  'Use get_summary, get_messages, get_updates, or send_message with sessionId to continue an existing Session. ' +
  'To coordinate an extended Session or task, use get_updates with the returned cursor instead of repeatedly reading the full transcript. Summarize substantive outbound messages as “Codex → Roomote” and substantive new Roomote replies as “Roomote → Codex”; relay questions and input needs promptly, do not narrate unchanged polls, and keep the final answer self-contained. Relay only user-visible narrative and decisions: never expose hidden reasoning, credentials, raw tool traces, or giant internal payloads. ' +
  'To communicate with a specific coding task instead, pass its concrete taskId to get_summary, get_messages, get_updates, or send_message; taskId takes precedence when both IDs are present. ' +
  'Use search_tasks, get_compute_logs, launch, cancel, list_models, or update_models only for explicit task-level inspection and control.';

export interface RoomoteSessionChildTask {
  taskId: string;
  title: string | null;
  state: TaskState;
  goalStatus: TaskGoalStatus | null;
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
  'Roomote → Codex',
  'Codex → Roomote',
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
  goalStatus: TaskGoalStatus | null;
}

export interface RoomoteSessionRelayState {
  kind: 'session';
  status: SessionStatus | null;
  tasks: Array<{
    taskId: string;
    state: TaskState;
    taskRunStatus: string | null;
    taskPhase: TaskPhase | null;
    goalStatus: TaskGoalStatus | null;
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
  direction: 'Codex → Roomote';
  target: { kind: 'task' | 'session'; id: string };
  text: string;
}
