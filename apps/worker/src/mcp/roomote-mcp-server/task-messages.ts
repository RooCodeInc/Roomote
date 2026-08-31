import { getTaskMessages } from './tasks-api-client.js';
import { textResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const MESSAGE_TEXT_LIMIT = 500;
const UNKNOWN_ROLE = 'unknown';

function inferRoleFromEventType(eventType: string): string | null {
  if (eventType.startsWith('roomote_runtime.user')) return 'user';
  if (eventType.startsWith('roomote_runtime.assistant')) return 'assistant';
  if (eventType.startsWith('roomote_runtime.system')) return 'system';
  if (eventType.startsWith('roomote_runtime.tool')) return 'tool';

  return null;
}

function getMessageRole(message: {
  role: string | null;
  eventType: string;
}): string {
  return (
    message.role ?? inferRoleFromEventType(message.eventType) ?? UNKNOWN_ROLE
  );
}

export async function handleGetTaskMessages(
  params: { taskId: string; limit?: number },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getTaskMessages(config, params.taskId, {
      limit: params.limit,
      order: 'desc',
    });

    const messages = result.messages;

    if (messages.length === 0) {
      return textResult('No messages found for this task.');
    }

    const lines = messages.map((m) => {
      const role = getMessageRole(m);
      const label = m.eventType;
      const prefix = `[${role}] (${label})`;
      const text = m.text
        ? m.text.length > MESSAGE_TEXT_LIMIT
          ? m.text.slice(0, MESSAGE_TEXT_LIMIT) + '...'
          : m.text
        : '(no text)';
      return `${prefix}\n${text}`;
    });

    const header = params.limit
      ? `Latest ${messages.length} message(s) for task ${params.taskId}:`
      : `${messages.length} message(s) for task ${params.taskId}:`;

    return textResult([header, '', ...lines].join('\n\n'));
  } catch (error) {
    return catchError(error);
  }
}
