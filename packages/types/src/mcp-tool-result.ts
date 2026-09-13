export type McpToolResultSemantics = {
  result: unknown;
  isError: boolean;
  errorText: string | null;
  payload: unknown | null;
};

export function parseMcpToolResult(result: unknown): McpToolResultSemantics {
  if (!result || typeof result !== 'object') {
    return {
      result,
      isError: false,
      errorText: null,
      payload: result ?? null,
    };
  }

  const toolResult = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const textPart = Array.isArray(toolResult.content)
    ? toolResult.content.find(
        (part): part is { type: 'text'; text: string } =>
          part.type === 'text' && typeof part.text === 'string',
      )
    : undefined;

  if (toolResult.isError === true) {
    return {
      result,
      isError: true,
      errorText: textPart?.text ?? null,
      payload: null,
    };
  }

  if (toolResult.structuredContent != null) {
    return {
      result,
      isError: false,
      errorText: null,
      payload: toolResult.structuredContent,
    };
  }

  if (Array.isArray(toolResult.content)) {
    if (!textPart) {
      return {
        result,
        isError: false,
        errorText: null,
        payload: toolResult.content,
      };
    }

    try {
      return {
        result,
        isError: false,
        errorText: null,
        payload: JSON.parse(textPart.text),
      };
    } catch {
      return {
        result,
        isError: false,
        errorText: null,
        payload: textPart.text,
      };
    }
  }

  return { result, isError: false, errorText: null, payload: result };
}
