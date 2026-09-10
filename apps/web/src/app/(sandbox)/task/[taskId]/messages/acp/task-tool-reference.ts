import {
  readToolArguments,
  resolveToolPresentation,
} from './tool-presentation';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

export type TaskToolReference = { taskId: string | null } | null;

const DIRECT_TASK_TOOLS = new Set([
  'launch_task',
  'review_pull_request',
  'send_task_message',
  'cancel_task',
  'retry_task_start',
]);
const SESSION_OR_TASK_ACTIONS = new Set([
  'get_summary',
  'get_messages',
  'get_updates',
  'send_message',
]);
const TASK_ACTIONS = new Set([
  ...SESSION_OR_TASK_ACTIONS,
  'cancel',
  'get_compute_logs',
  'launch',
  'update_models',
]);

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveTaskToolReference(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  context?: {
    currentTaskId?: string;
    orderedTaskIds?: readonly string[];
  } | null,
): TaskToolReference {
  const { identity } = resolveToolPresentation(msg.data, msg.partial);
  const { toolName, providerKind, serverName } = identity;
  if (!toolName || (providerKind === 'mcp' && serverName !== 'roomote')) {
    return null;
  }

  const currentTaskId = nonemptyString(context?.currentTaskId);
  // Parent reports describe their source, not a child or the destination Session.
  if (toolName === 'report_to_parent_session') return { taskId: currentTaskId };

  const isDirect = DIRECT_TASK_TOOLS.has(toolName);
  const isManagement = toolName === 'manage_tasks';
  if (!isDirect && !isManagement && toolName !== 'receive_task_report')
    return null;

  const args = readToolArguments(msg.data);
  const action = nonemptyString(args?.action);
  if (isManagement && (!action || !TASK_ACTIONS.has(action))) return null;

  const inputTaskId = nonemptyString(args?.taskId);
  if (inputTaskId) return { taskId: inputTaskId };

  const isSessionOrTask = isManagement && SESSION_OR_TASK_ACTIONS.has(action!);
  if (isSessionOrTask && nonemptyString(args?.sessionId)) {
    return currentTaskId ? { taskId: currentTaskId } : null;
  }

  if (msg.kind === 'tool_result') {
    try {
      let result = asRecord(JSON.parse(msg.data.output));
      // Only structural result envelopes and typed task targets carry identity.
      // Never infer a task from Session IDs, prose, or a list of child tasks.
      for (let depth = 0; result && depth < 4; depth += 1) {
        const target = asRecord(result.target);
        const taskId =
          nonemptyString(result.taskId) ??
          (target?.kind === 'task' ? nonemptyString(target.id) : null);
        if (taskId) return { taskId };
        if (
          isSessionOrTask &&
          (target?.kind === 'session' || nonemptyString(result.sessionId))
        ) {
          return currentTaskId ? { taskId: currentTaskId } : null;
        }
        result = asRecord(result.result) ?? asRecord(result.data);
      }
    } catch {
      // Unstructured receipts retain the input identity or the generic invader.
    }
  }

  if (isSessionOrTask) return currentTaskId ? { taskId: currentTaskId } : null;
  if (isManagement && action === 'update_models')
    return { taskId: currentTaskId };
  return {
    taskId:
      isDirect && context?.orderedTaskIds?.length === 1
        ? context.orderedTaskIds[0]!
        : null,
  };
}
