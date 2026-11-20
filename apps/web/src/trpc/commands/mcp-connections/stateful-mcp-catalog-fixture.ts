import { createServer } from 'node:http';

export async function startStatefulMcpCatalog(
  options: {
    expire?: 'once' | 'always';
    sse?: boolean;
    stateless?: boolean;
    initializeError?: boolean;
    listError?: boolean;
    unauthorized?: boolean;
    unauthorizedOnList?: boolean;
    notificationError?: boolean;
    deleteError?: boolean;
  } = {},
) {
  const requests: Array<{
    method: string;
    sessionId?: string;
    cursor?: string;
  }> = [];
  const sessions = new Map<string, boolean>();
  let generations = 0;
  const server = createServer(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const method = req.method === 'DELETE' ? 'DELETE' : body.method;
    requests.push({ method, sessionId, cursor: body.params?.cursor });
    const reply = (status: number, result: unknown, error?: string) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? null,
        ...(error ? { error: { code: -32000, message: error } } : { result }),
      });
      res.writeHead(status, {
        'content-type': options.sse ? 'text/event-stream' : 'application/json',
      });
      res.end(options.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    };
    if (
      options.unauthorized ||
      req.headers.authorization !== 'Bearer catalog-test-token'
    ) {
      reply(401, null, 'Unauthorized');
      return;
    }
    if (method === 'initialize') {
      if (sessionId) {
        reply(400, null, 'Initialize must not reuse a previous session');
        return;
      }
      if (options.initializeError) {
        reply(200, null, 'Initialization refused');
        return;
      }
      const id = `catalog-${++generations}`;
      sessions.set(id, false);
      if (!options.stateless) res.setHeader('mcp-session-id', id);
      reply(200, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'stateful-catalog', version: '1' },
      });
      return;
    }
    if (!options.stateless && !sessionId) {
      reply(
        400,
        null,
        'Request must be an initialize request if no session ID is provided.',
      );
      return;
    }
    if (!options.stateless && !sessions.has(sessionId!)) {
      reply(404, null, 'Session not found');
      return;
    }
    if (req.headers['mcp-protocol-version'] !== '2024-11-05') {
      reply(400, null, 'Use the negotiated protocol version');
      return;
    }
    if (method === 'DELETE') {
      sessions.delete(sessionId!);
      res.writeHead(options.deleteError ? 405 : 204).end();
      return;
    }
    if (method === 'notifications/initialized') {
      if (options.notificationError) {
        reply(500, null, 'Notification refused');
        return;
      }
      sessions.set(sessionId ?? 'stateless', true);
      res.writeHead(202).end();
      return;
    }
    if (!sessions.get(sessionId ?? 'stateless')) {
      reply(400, null, 'Send notifications/initialized before listing tools');
      return;
    }
    if (options.listError) {
      reply(500, null, 'Tool catalog unavailable');
      return;
    }
    if (options.unauthorizedOnList) {
      reply(401, null, 'Unauthorized');
      return;
    }
    if (
      body.params?.cursor &&
      (options.expire === 'always' ||
        (options.expire === 'once' && generations === 1))
    ) {
      sessions.delete(sessionId!);
      reply(404, null, 'Session expired');
      return;
    }
    reply(
      200,
      body.params?.cursor
        ? {
            tools: [
              { name: 'listJiraProjects', annotations: { readOnlyHint: true } },
              { name: 'editJiraIssue' },
            ],
          }
        : {
            tools: [
              {
                name: 'getJiraIssue',
                description: 'Read an issue',
                annotations: { readOnlyHint: true },
              },
            ],
            nextCursor: 'next-page',
          },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP listener');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
