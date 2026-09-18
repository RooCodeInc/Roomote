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
    content?: Array<{
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
  };
  const textPart = Array.isArray(toolResult.content)
    ? toolResult.content.find(
        (part): part is { type: 'text'; text: string } =>
          part.type === 'text' && typeof part.text === 'string',
      )
    : undefined;
  const imagePart = Array.isArray(toolResult.content)
    ? toolResult.content.find(
        (part): part is { type: 'image'; data: string; mimeType: string } =>
          part.type === 'image' &&
          typeof part.data === 'string' &&
          typeof part.mimeType === 'string',
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
    const structuredText =
      textPart &&
      typeof toolResult.structuredContent === 'object' &&
      !Array.isArray(toolResult.structuredContent) &&
      (toolResult.structuredContent as { kind?: unknown }).kind === 'text'
        ? { text: textPart.text }
        : {};
    const payload =
      typeof toolResult.structuredContent === 'object' &&
      !Array.isArray(toolResult.structuredContent)
        ? {
            ...(toolResult.structuredContent as Record<string, unknown>),
            ...structuredText,
            ...(imagePart
              ? { data: imagePart.data, mimeType: imagePart.mimeType }
              : {}),
          }
        : toolResult.structuredContent;
    return {
      result,
      isError: false,
      errorText: null,
      payload,
    };
  }

  if (Array.isArray(toolResult.content)) {
    if (toolResult.content.some((part) => part.type !== 'text')) {
      return {
        result,
        isError: false,
        errorText: null,
        payload: toolResult.content,
      };
    }

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
