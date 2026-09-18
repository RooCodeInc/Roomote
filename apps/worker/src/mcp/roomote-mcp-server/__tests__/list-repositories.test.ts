import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import superjson from 'superjson';

import { handleListRepositories } from '../list-repositories';

const config = {
  token: 'run-token',
  platformApiUrl: 'https://api.example.test',
};

function readToolJson(result: { content: { type: string; text?: string }[] }) {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

const page = {
  success: true,
  repositories: [
    {
      fullName: 'octo/widgets',
      sourceControlProvider: 'github',
      defaultBranch: 'main',
      private: true,
      checkedOut: false,
    },
  ],
  totalCount: 1,
};

describe('handleListRepositories', () => {
  let server: Server;
  let sandboxServerUrl: string;
  let lastRequest: { authorization?: string; path: string; input: unknown };
  let respond: () => { status: number; body: unknown };

  beforeEach(async () => {
    respond = () => ({
      status: 200,
      body: { result: { data: superjson.serialize(page) } },
    });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://sandbox.test');
      const batch = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<
        string,
        never
      >;
      lastRequest = {
        authorization: req.headers.authorization,
        path: url.pathname,
        input: batch['0'] ? superjson.deserialize(batch['0']) : undefined,
      };
      const response = respond();
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify([response.body]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    sandboxServerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('queries the local sandbox server with the run token and returns the page', async () => {
    const result = await handleListRepositories(
      { query: ' widgets ', offset: 50, limit: 25 },
      config,
      { sandboxServerUrl },
    );

    expect(lastRequest.authorization).toBe('Bearer run-token');
    expect(lastRequest.path).toBe('/trpc/commands.listRepositories');
    expect(lastRequest.input).toEqual({
      query: 'widgets',
      offset: 50,
      limit: 25,
    });
    expect(readToolJson(result)).toEqual(page);
  });

  it('treats null and blank arguments as absent', async () => {
    await handleListRepositories(
      { query: '  ', offset: null, limit: null },
      config,
      { sandboxServerUrl },
    );

    expect(lastRequest.input).toEqual({});
  });

  it('surfaces sandbox server errors as tool errors', async () => {
    respond = () => ({
      status: 403,
      body: {
        error: {
          json: {
            message:
              'Repository checkout on demand is unavailable because this run has no authorized repository scope.',
            code: -32003,
            data: { code: 'FORBIDDEN', httpStatus: 403 },
          },
        },
      },
    });

    const result = await handleListRepositories({}, config, {
      sandboxServerUrl,
    });

    expect(readToolJson(result)).toEqual({
      success: false,
      error:
        'Failed to list repositories: Repository checkout on demand is unavailable because this run has no authorized repository scope.',
    });
  });
});
