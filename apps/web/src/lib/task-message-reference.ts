export function getTaskMessageReference(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const toolName = String(data.toolName ?? data.mcpToolName ?? data.title ?? '')
    .toLowerCase()
    .replace(/^.*[.:/]/, '');
  if (toolName !== 'send_task_message' && toolName !== 'receive_task_report') {
    return null;
  }

  const rawInput = data.rawInput as Record<string, unknown> | null;
  const args = (rawInput?.arguments ?? rawInput) as Record<
    string,
    unknown
  > | null;
  let taskId = args?.taskId;
  if (toolName === 'send_task_message' && typeof data.output === 'string') {
    try {
      const output = JSON.parse(data.output) as { taskId?: unknown } | null;
      if (typeof output?.taskId === 'string') taskId = output.taskId;
    } catch {
      // Failed calls and older receipts may not contain a resolved task.
    }
  }
  return {
    label:
      toolName === 'send_task_message' ? 'Destination task' : 'Source task',
    taskId: typeof taskId === 'string' && taskId.trim() ? taskId : null,
    title: typeof data.taskTitle === 'string' ? data.taskTitle.trim() : null,
  };
}
