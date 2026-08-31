import { z } from 'zod';

import { SESSION_STATUSES, type SessionStatus } from './sessions';
import type { RoomoteTranscriptMessage } from './task-messages';
import type { TaskGoalStatus, TaskPhase, TaskState } from './task-runs';
import {
  ROOMOTE_TASK_INSPECTION_ACTIONS,
  roomoteTaskInspectionFieldSchemas,
} from './task-inspection-tool';

export const ROOMOTE_SESSION_MANAGEMENT_ACTIONS = [
  'start_session',
  'search_sessions',
  'get_session_summary',
  'get_session_messages',
] as const;

export const ROOMOTE_TASK_COMPATIBILITY_ACTIONS = [
  ...ROOMOTE_TASK_INSPECTION_ACTIONS,
  'launch',
  'cancel',
  'send_message',
  'list_environments',
] as const;

export const ROOMOTE_MEMBER_MANAGEMENT_ACTIONS = [
  ...ROOMOTE_SESSION_MANAGEMENT_ACTIONS,
  ...ROOMOTE_TASK_COMPATIBILITY_ACTIONS,
] as const;

export const roomoteManagementFieldSchemas = {
  ...roomoteTaskInspectionFieldSchemas,
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Canonical Roomote session ID for session inspection actions'),
  sessionStatus: z
    .enum(SESSION_STATUSES)
    .optional()
    .describe('Filter sessions by current status (for search_sessions)'),
  message: z
    .string()
    .optional()
    .describe(
      'Message text for start_session or a follow-up message for send_message',
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
  'Create and inspect Roomote sessions, with direct task operations retained for compatibility. ' +
  'Use start_session for new work, search_sessions to find existing work, and get_session_summary or get_session_messages to inspect a session and its child tasks. ' +
  'Use the task-oriented search, get_summary, get_compute_logs, get_messages, launch, cancel, and send_message actions only when a direct task operation is specifically required. ' +
  'For get_messages and send_message, taskId may still be a task ID, canonical Roomote session ID, or Fast conversation ID during migration.';

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
