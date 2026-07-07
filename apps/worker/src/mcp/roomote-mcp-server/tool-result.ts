import type { ToolResult } from './types.js';

export function errorResult(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: false, error: message }),
      },
    ],
  };
}

export function successResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, ...data }),
      },
    ],
  };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult<T extends object>(data: T): ToolResult {
  return {
    structuredContent: data as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

export function catchError(error: unknown): ToolResult {
  return errorResult(error instanceof Error ? error.message : String(error));
}
