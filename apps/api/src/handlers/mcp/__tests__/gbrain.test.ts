import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Hono } from 'hono';
import {
  BRAIN_MCP_READ_INSTRUCTIONS,
  type RunTokenContext,
} from '@roomote/types';

import type { Variables } from '../../../types';

const { mockResolveConnection, mockIsBrainEmbeddingAvailable } = vi.hoisted(
  () => ({
    mockResolveConnection: vi.fn(),
    mockIsBrainEmbeddingAvailable: vi.fn(),
  }),
);

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: mockResolveConnection,
  isBrainEmbeddingAvailable: mockIsBrainEmbeddingAvailable,
}));

import { createGbrainMcpProxy, GBRAIN_READ_TOOL_NAMES } from '../gbrain';

function createRunToken(): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
  };
}

function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', createRunToken());
    await next();
  });

  app.route('/gbrain', createGbrainMcpProxy());
  return app;
}

async function postMcp(app: Hono<{ Variables: Variables }>, body: unknown) {
  return app.request('/gbrain', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function toolCall(name: string) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: {} },
  };
}

describe('createGbrainMcpProxy', () => {
  let upstream: Server | null = null;
  let upstreamRequests: Array<{ authorization?: string; body: string }>;

  beforeEach(() => {
    upstreamRequests = [];
    mockResolveConnection.mockReset();
    // A Brain is only offered to agents when it can actually embed, so the
    // default for these cases is "an embedder is available".
    mockIsBrainEmbeddingAvailable.mockReset();
    mockIsBrainEmbeddingAvailable.mockResolvedValue(true);
  });

  afterEach(async () => {
    if (upstream) {
      await new Promise((resolve) => upstream?.close(resolve));
      upstream = null;
    }
  });

  async function startUpstream(): Promise<string> {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        upstreamRequests.push({
          authorization: req.headers.authorization,
          body,
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [] } }),
        );
      });
    });

    await new Promise<void>((resolve) => upstream?.listen(0, resolve));
    const { port } = upstream?.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('404s when the deployment has no Brain', async () => {
    mockResolveConnection.mockResolvedValue(null);

    const response = await postMcp(createApp(), toolCall('query'));

    expect(response.status).toBe(404);
    expect(mockResolveConnection).toHaveBeenCalledWith('agent');
  });

  it('hides the Brain from agents when it cannot embed', async () => {
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'agent-token',
    });
    mockIsBrainEmbeddingAvailable.mockResolvedValue(false);

    const response = await postMcp(createApp(), toolCall('query'));

    // Worse than absent: a Brain that cannot embed still answers keyword
    // queries, so retrieval would look real while missing everything semantic.
    expect(response.status).toBe(404);
  });

  it('serves agents on an embedder-only deployment with no provider key', async () => {
    // The trial / Anthropic-only case: a self-run embedder is configured and
    // no OpenAI/OpenRouter key exists. The drain ingests such a Brain, so the
    // read path must let agents query it too.
    mockResolveConnection.mockResolvedValue({
      baseUrl: await startUpstream(),
      token: 'agent-token',
    });
    mockIsBrainEmbeddingAvailable.mockResolvedValue(true);

    const response = await postMcp(createApp(), toolCall('query'));

    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.authorization).toBe('Bearer agent-token');
  });

  it.each(['remember', 'forget'])(
    'blocks the %s write tool before it reaches upstream',
    async (name) => {
      mockResolveConnection.mockResolvedValue({
        baseUrl: await startUpstream(),
        token: 'agent-token',
      });

      const response = await postMcp(createApp(), toolCall(name));
      const payload = await response.json();

      expect(payload).toHaveProperty('error');
      expect(upstreamRequests).toHaveLength(0);
    },
  );

  it('forwards read tools with the read-only agent credential', async () => {
    mockResolveConnection.mockResolvedValue({
      baseUrl: await startUpstream(),
      token: 'agent-token',
    });

    const response = await postMcp(createApp(), toolCall('query'));

    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.authorization).toBe('Bearer agent-token');
    expect(upstreamRequests[0]?.body).toContain('"query"');
  });

  it('does not include write verbs in the read allowlist', () => {
    expect(GBRAIN_READ_TOOL_NAMES).not.toContain('remember');
    expect(GBRAIN_READ_TOOL_NAMES).not.toContain('forget');
    expect(GBRAIN_READ_TOOL_NAMES).not.toContain('put_page');
    expect(GBRAIN_READ_TOOL_NAMES).not.toContain('delete_page');
  });

  it('allows browsing so "what do you know?" is answerable', () => {
    for (const tool of [
      'list_pages',
      'get_page',
      'search',
      'query',
      'entity',
    ]) {
      expect(GBRAIN_READ_TOOL_NAMES).toContain(tool);
    }
  });

  it.each(['list_pages', 'search'])(
    'forwards the %s browse tool',
    async (name) => {
      mockResolveConnection.mockResolvedValue({
        baseUrl: await startUpstream(),
        token: 'agent-token',
      });

      const response = await postMcp(createApp(), toolCall(name));

      expect(response.status).toBe(200);
      expect(upstreamRequests).toHaveLength(1);
    },
  );
});

describe('Brain agent allowlist', () => {
  it('keeps the specialized read instructions aligned with exposed tools', () => {
    for (const tool of GBRAIN_READ_TOOL_NAMES) {
      expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(`\`${tool}\``);
    }
  });

  it('exposes no write or admin surface', () => {
    // gbrain publishes 100+ tools including writes, job control and schema
    // mutation. Reads flow through here; writes only ever go through the
    // server-side ingestion path with its own credential.
    for (const forbidden of [
      'remember',
      'forget',
      'put_page',
      'delete_page',
      'submit_job',
      'schema_apply_mutations',
      'sources_remove',
    ]) {
      expect(GBRAIN_READ_TOOL_NAMES).not.toContain(forbidden);
    }
  });
});
