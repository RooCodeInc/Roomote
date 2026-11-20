import { parseMcpJsonRpcPayload } from '../mcp-response-parsing';

const notification = {
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { data: 'Preparing result' },
};
const response = {
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2025-06-18' },
};

function stream(...messages: unknown[]) {
  return messages
    .map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`)
    .join('');
}

describe('ID-aware MCP response parsing', () => {
  it.each(['\n', '\r\n'])(
    'selects the matching response after notifications, requests, and unrelated responses (%j)',
    (newline) => {
      const body = stream(
        notification,
        { jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' },
        { jsonrpc: '2.0', id: '1', result: { wrong: true } },
        response,
      ).replaceAll('\n', newline);
      expect(parseMcpJsonRpcPayload(body, 'text/event-stream', 1)).toEqual(
        response,
      );
    },
  );

  it('selects a matching error rather than a preceding notification', () => {
    const error = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'Initialization refused' },
    };
    expect(
      parseMcpJsonRpcPayload(
        stream(notification, error),
        'text/event-stream',
        1,
      ),
    ).toEqual(error);
  });

  it.each([undefined, null, '1', 2])(
    'rejects JSON responses with an absent or different ID (%j)',
    (id) => {
      expect(
        parseMcpJsonRpcPayload(
          JSON.stringify({ ...response, id }),
          'application/json',
          1,
        ),
      ).toBeNull();
    },
  );

  it('returns null when an SSE body contains no matching response', () => {
    expect(
      parseMcpJsonRpcPayload(
        stream(notification, { ...response, id: 2 }),
        'text/event-stream',
        1,
      ),
    ).toBeNull();
  });

  it('supports string request IDs and matching JSON responses', () => {
    expect(
      parseMcpJsonRpcPayload(JSON.stringify(response), 'application/json', 1),
    ).toEqual(response);
    const stringResponse = { ...response, id: 'catalog' };
    expect(
      parseMcpJsonRpcPayload(
        stream(notification, stringResponse),
        'text/event-stream',
        'catalog',
      ),
    ).toEqual(stringResponse);
  });

  it('preserves first-payload behavior for callers that do not specify an ID', () => {
    expect(
      parseMcpJsonRpcPayload(
        stream(notification, response),
        'text/event-stream',
      ),
    ).toEqual(notification);
  });
});
