import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

type ToolMessage = AcpToolCallUiMessage | AcpToolResultUiMessage;

interface DelegatedTaskDetails {
  taskId: string;
  prompt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getDelegatedTaskDetails(
  msg: ToolMessage,
): DelegatedTaskDetails | null {
  const toolName = (msg.data.toolName ?? msg.data.mcpToolName)
    ?.trim()
    .toLowerCase();

  if (
    msg.kind !== 'tool_result' ||
    (toolName !== 'launch_task' && toolName !== 'review_pull_request')
  ) {
    return null;
  }

  try {
    const parsed = asRecord(JSON.parse(msg.data.output));
    const result = asRecord(parsed?.result) ?? asRecord(parsed?.data) ?? parsed;
    // A reused already-running review belongs to another launch; the reply
    // explains where its results land, and no card should expose that task.
    if (result?.alreadyRunning === true) {
      return null;
    }
    const taskId = result?.taskId;

    if (typeof taskId !== 'string' || taskId.length === 0) {
      return null;
    }

    const rawInput = asRecord(
      (msg.data as unknown as Record<string, unknown>).rawInput,
    );
    const args = asRecord(rawInput?.arguments);
    const prompt = args?.prompt;

    return {
      taskId,
      prompt:
        typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null,
    };
  } catch {
    return null;
  }
}
