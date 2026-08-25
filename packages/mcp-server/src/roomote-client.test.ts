import { resolveRoomoteMcpUrl } from './roomote-client.js';

describe('resolveRoomoteMcpUrl', () => {
  it('adds the public MCP path to a deployment URL', () => {
    expect(resolveRoomoteMcpUrl('https://roomote.example').toString()).toBe(
      'https://roomote.example/mcp',
    );
  });

  it('preserves an explicit MCP endpoint', () => {
    expect(
      resolveRoomoteMcpUrl('https://roomote.example/base/mcp/').toString(),
    ).toBe('https://roomote.example/base/mcp');
  });
});
