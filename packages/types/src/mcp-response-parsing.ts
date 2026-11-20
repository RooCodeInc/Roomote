export type McpToolsListJsonRpcPayload = {
  error?: { code?: unknown; message?: unknown };
  result?: { tools?: Array<Record<string, unknown>>; nextCursor?: unknown };
};

/**
 * The MCP `annotations.readOnlyHint` of one upstream `tools/list` entry, or
 * null when the server does not say. The hint is advisory metadata from the
 * server, so it only drives presentation (grouping read-only tools apart from
 * ones that can write), never an access decision.
 */
export function readMcpToolReadOnlyHint(tool: unknown): boolean | null {
  if (!tool || typeof tool !== 'object') return null;
  const annotations = (tool as { annotations?: unknown }).annotations;
  if (!annotations || typeof annotations !== 'object') return null;
  const hint = (annotations as { readOnlyHint?: unknown }).readOnlyHint;
  return typeof hint === 'boolean' ? hint : null;
}

function tryParseMcpJsonRpcPayload(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function matchesResponseId(
  payload: unknown,
  responseId: string | number,
): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'id' in payload &&
    payload.id === responseId &&
    ('result' in payload || 'error' in payload)
  );
}

function parseSseMcpJsonRpcPayload(
  bodyText: string,
  responseId?: string | number,
): unknown | null {
  for (const chunk of bodyText.split(/\r?\n\r?\n/)) {
    const dataLines = chunk
      .split(/\r?\n/)
      .flatMap((line) =>
        line.startsWith('data:')
          ? [line.slice('data:'.length).trimStart()]
          : [],
      );

    if (dataLines.length === 0) {
      continue;
    }

    const payload = tryParseMcpJsonRpcPayload(dataLines.join('\n').trim());
    if (
      payload &&
      (responseId === undefined || matchesResponseId(payload, responseId))
    ) {
      return payload;
    }
  }

  return null;
}

export function parseMcpJsonRpcPayload(
  bodyText: string,
  contentType: string | null,
  /** When supplied, skip notifications/other responses and require this request's result or error. */
  responseId?: string | number,
): unknown | null {
  const trimmedBody = bodyText.trim();
  if (trimmedBody.length === 0) {
    return null;
  }

  const looksLikeSse =
    contentType?.includes('text/event-stream') === true ||
    trimmedBody.startsWith('event:') ||
    trimmedBody.startsWith('data:');

  if (looksLikeSse) {
    return parseSseMcpJsonRpcPayload(trimmedBody, responseId);
  }

  const payload = tryParseMcpJsonRpcPayload(trimmedBody);
  return responseId === undefined || matchesResponseId(payload, responseId)
    ? payload
    : null;
}
