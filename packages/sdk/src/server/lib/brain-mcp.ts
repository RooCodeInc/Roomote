/**
 * The one gbrain MCP transport.
 *
 * Every Roomote surface that talks to the Brain speaks the same protocol: a
 * JSON-RPC `tools/call` POST to `/mcp` with a bearer token, answered either
 * as a bare JSON document or as Streamable-HTTP SSE `data:` frames. This
 * module owns that shape so a protocol change (a new required header, a
 * session id, different framing) lands once instead of in every caller.
 *
 * Deliberately no error classification beyond the protocol itself: what a
 * 429 or an embedding failure *means* belongs to the call site (the outbox
 * drainer treats them as backpressure; a settings read treats them as an
 * unreachable corpus).
 */

export type BrainToolConnection = { baseUrl: string; token: string };

export type BrainToolResponse = {
  status: number;
  ok: boolean;
  /** The raw response text, for callers that classify by content. */
  body: string;
};

/**
 * Transport only: POST one tool call and hand back the raw response. Throws
 * only what fetch throws (network errors, and `TimeoutError` when
 * `timeoutMs` is set); HTTP failures are returned, not thrown, so callers
 * can classify them.
 */
export async function postBrainToolCall(
  connection: BrainToolConnection,
  tool: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<BrainToolResponse> {
  const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    ...(options.timeoutMs
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  });
  const body = await response.text().catch(() => '');

  return { status: response.status, ok: response.ok, body };
}

/**
 * Unwrap a Streamable-HTTP MCP body: SSE `data:` frames when gbrain streams
 * (the request's accept header invites it), else a bare JSON document. The
 * last frame carries the JSON-RPC response.
 */
export function parseBrainJsonRpcBody(body: string): unknown {
  const trimmed = body.trim();
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]');

  if (dataLines.length === 0) {
    return JSON.parse(trimmed);
  }

  const events = dataLines.map((line) => JSON.parse(line) as unknown);

  return events.at(-1);
}

/**
 * Parse a successful tool call's payloads: the structured content first,
 * then each text content item (JSON-decoded where possible, raw text where
 * not). Throws on a JSON-RPC error or a tool-level `isError`, with the
 * tool's own detail in the message so callers can match on it.
 */
export function parseBrainToolPayloads(
  body: string,
  tool = 'tool call',
): unknown[] {
  const envelope = parseBrainJsonRpcBody(body) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
  };

  if (envelope.error) {
    throw new Error(
      `gbrain ${tool} failed: ${envelope.error.message ?? 'JSON-RPC error'}`,
    );
  }

  if (envelope.result?.isError) {
    const detail = envelope.result.content
      ?.map((item) => item.text)
      .filter(Boolean)
      .join(' ');

    throw new Error(`gbrain ${tool} failed: ${detail ?? 'tool error'}`);
  }

  return [
    envelope.result?.structuredContent,
    ...(envelope.result?.content
      ?.filter((item) => item.type === 'text' && item.text)
      .map((item) => {
        try {
          return JSON.parse(item.text!) as unknown;
        } catch {
          return item.text;
        }
      }) ?? []),
  ].filter((payload) => payload !== undefined);
}

/**
 * Call one read-shaped tool and return its parsed payloads. Throws on HTTP
 * failure, JSON-RPC error, or tool error; write paths that classify raw
 * bodies build on `postBrainToolCall` instead.
 */
export async function callBrainTool(
  connection: BrainToolConnection,
  tool: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const response = await postBrainToolCall(connection, tool, args, options);

  if (!response.ok) {
    throw new Error(
      `gbrain ${tool} failed: ${response.status} ${response.body.slice(0, 300)}`,
    );
  }

  return parseBrainToolPayloads(response.body, tool);
}
