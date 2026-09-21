import { getTaskMessages } from './tasks-api-client.js';
import { catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const MESSAGE_TEXT_LIMIT = 500;
const UNKNOWN_ROLE = 'unknown';

function getSubagentLabel(metadata: Record<string, unknown> | null): string {
  const parentSessionId = metadata?.parentSessionId;
  const childSessionId = metadata?.sessionId;

  if (
    typeof parentSessionId !== 'string' ||
    typeof childSessionId !== 'string'
  ) {
    return '';
  }

  const agentType =
    typeof metadata?.agentType === 'string' ? metadata.agentType : 'unknown';
  return ` [subagent:${agentType} session:${childSessionId} parent:${parentSessionId}]`;
}

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
  params: { taskId: string; limit?: number; cursor?: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getTaskMessages(config, params.taskId, {
      limit: params.limit,
      order: 'desc',
      cursor: params.cursor,
    });

    const messages = result.messages;
    const lines = messages.map((m) => {
      const role = getMessageRole(m);
      const label = m.eventType;
      const prefix = `[${role}] (${label})${getSubagentLabel(m.metadata)}`;
      const text = m.text
        ? m.text.length > MESSAGE_TEXT_LIMIT
          ? m.text.slice(0, MESSAGE_TEXT_LIMIT) + '...'
          : m.text
        : '(no text)';
      return `${prefix}\n${text}`;
    });

    const header = params.cursor
      ? `History page with ${messages.length} message(s) for task ${params.taskId}:`
      : params.limit
        ? `Latest ${messages.length} message(s) for task ${params.taskId}:`
        : `${messages.length} message(s) for task ${params.taskId}:`;
    const footer = result.hasMore
      ? [
          `History page truncated: ${result.truncated}.`,
          `More history is available; call get_messages with cursor: ${result.nextCursor}`,
        ]
      : [
          `History coverage complete: true${result.truncated ? ' (page content was truncated).' : '.'}`,
        ];
    if (result.hasNewer) {
      footer.push(
        'Newer messages arrived after this history snapshot; restart without a cursor to include them.',
      );
    }

    return {
      structuredContent: { ...result },
      content: [
        {
          type: 'text',
          text: [
            messages.length === 0 ? 'No messages found for this task.' : header,
            ...(messages.length > 0 ? ['', ...lines] : []),
            '',
            ...footer,
          ].join('\n\n'),
        },
      ],
    };
  } catch (error) {
    return catchError(error);
  }
}
