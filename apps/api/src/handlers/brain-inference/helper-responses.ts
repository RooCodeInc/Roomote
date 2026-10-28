/** Translate the native OpenAI Responses text contract into the helper input. */
export function responsesHelperBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    body.previous_response_id
  ) {
    return null;
  }

  if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
    return null;
  }

  const input =
    typeof body.input === 'string'
      ? [{ role: 'user', content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : [];

  if (!input.every(isHelperResponseMessage)) {
    return null;
  }

  const text =
    body.text && typeof body.text === 'object'
      ? (body.text as Record<string, unknown>)
      : undefined;
  const format =
    text?.format && typeof text.format === 'object'
      ? (text.format as Record<string, unknown>)
      : undefined;

  return {
    ...body,
    messages: [
      ...(typeof body.instructions === 'string'
        ? [{ role: 'system', content: body.instructions }]
        : []),
      ...input.map((message) =>
        message && typeof message === 'object' && message.role === 'developer'
          ? { ...message, role: 'system' }
          : message,
      ),
    ],
    max_tokens: body.max_output_tokens,
    response_format:
      format?.type === 'json_schema'
        ? { type: 'json_schema', json_schema: format }
        : format,
  };
}

function isHelperResponseMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  if (
    !['system', 'developer', 'user', 'assistant'].includes(String(record.role))
  ) {
    return false;
  }
  if (record.type !== undefined && record.type !== 'message') return false;
  if (typeof record.content === 'string') return true;
  return (
    Array.isArray(record.content) &&
    record.content.every((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const value = part as Record<string, unknown>;
      return (
        ['input_text', 'output_text'].includes(String(value.type)) &&
        typeof value.text === 'string'
      );
    })
  );
}
