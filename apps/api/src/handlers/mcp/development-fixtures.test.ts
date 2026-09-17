import { developmentFixturesMcp } from './development-fixtures';

const headers = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

function request(body: Record<string, unknown>) {
  return developmentFixturesMcp.request('/', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('developmentFixturesMcp', () => {
  it('advertises and executes only its deterministic read-only tool', async () => {
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fixture-test', version: '1.0.0' },
      },
    });
    expect(initialized.status).toBe(200);

    const listed = await request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    expect(await listed.json()).toMatchObject({
      result: {
        tools: [
          {
            name: 'list_fixture_records',
            annotations: {
              destructiveHint: false,
              openWorldHint: false,
              readOnlyHint: true,
            },
          },
        ],
      },
    });

    const called = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_fixture_records', arguments: {} },
    });
    expect(await called.json()).toMatchObject({
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('fixture-alpha'),
          },
        ],
      },
    });
  });
});
