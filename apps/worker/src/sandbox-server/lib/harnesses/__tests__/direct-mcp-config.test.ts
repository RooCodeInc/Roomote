import { parseDirectMcpConfig } from '../opencode-server/mcp-config';
import { createIntegrationMcpInstructions } from '../../../../run-task/agent-home';

describe('direct MCP runtime provenance', () => {
  it.each([undefined, 'unknown', true, { value: 'http-integrations-broker' }])(
    'drops unknown or missing provenance: %j',
    (roomoteManaged) => {
      const parsed = parseDirectMcpConfig({
        type: 'streamable-http',
        url: 'https://api.test/api/mcp/http-integrations',
        roomoteManaged,
      });
      expect(parsed).toEqual({
        type: 'streamable-http',
        url: 'https://api.test/api/mcp/http-integrations',
        headers: {},
      });
      expect(
        createIntegrationMcpInstructions([
          {
            ...parsed!,
            type: 'remote',
            name: '_roomote_http_integrations',
            url: 'https://api.test/api/mcp/http-integrations',
          },
        ]),
      ).toBeUndefined();
    },
  );

  it('accepts only the exact broker literal on remote configs', () => {
    expect(
      parseDirectMcpConfig({
        type: 'streamable-http',
        url: 'https://api.test/mcp',
        roomoteManaged: 'http-integrations-broker',
      }),
    ).toHaveProperty('roomoteManaged', 'http-integrations-broker');
    expect(
      parseDirectMcpConfig({
        type: 'stdio',
        command: 'node',
        roomoteManaged: 'http-integrations-broker',
      }),
    ).not.toHaveProperty('roomoteManaged');
  });
});
