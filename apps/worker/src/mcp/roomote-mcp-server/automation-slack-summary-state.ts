import type { ToolResult } from './types.js';

function parseToolResultPayload(
  result: ToolResult,
): Record<string, unknown> | null {
  const textContent = result.content?.find(
    (content) => content.type === 'text',
  );

  if (!textContent || typeof textContent.text !== 'string') {
    return null;
  }

  try {
    const payload = JSON.parse(textContent.text) as unknown;
    if (payload == null || typeof payload !== 'object') {
      return null;
    }

    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function taskSuggestionResultHasSubmittedSuggestions(
  result: ToolResult,
): boolean {
  const payload = parseToolResultPayload(result);

  return (
    payload?.success === true &&
    typeof payload.suggestionCount === 'number' &&
    payload.suggestionCount > 0
  );
}

export function automationWorkItemsResultHasSubmittedWorkItems(
  result: ToolResult,
): boolean {
  const payload = parseToolResultPayload(result);

  return (
    payload?.success === true &&
    typeof payload.workItemCount === 'number' &&
    payload.workItemCount > 0
  );
}
