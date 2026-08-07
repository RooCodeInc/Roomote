import { describe, expect, it } from 'vitest';

import {
  parseCustomMcpServerJson,
  sanitizeCustomMcpServerName,
} from './custom-mcp-json-import';

describe('parseCustomMcpServerJson', () => {
  it('imports a stdio server from an mcpServers wrapper', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        mcpServers: {
          'example-tools': {
            command: 'npx',
            args: ['-y', '@example/mcp-server'],
            env: { EXAMPLE_TOKEN: 'abc' },
          },
        },
      }),
    );

    expect(result).toEqual({
      name: 'example-tools',
      transport: 'stdio',
      stdio: {
        command: 'npx',
        args: ['-y', '@example/mcp-server'],
        env: { EXAMPLE_TOKEN: 'abc' },
      },
      notes: [],
    });
  });

  it("imports from VS Code's 'servers' wrapper", () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        servers: { example: { command: 'uvx', args: ['example-mcp'] } },
      }),
    );

    expect(result.name).toBe('example');
    expect(result.transport).toBe('stdio');
    expect(result.stdio?.command).toBe('uvx');
  });

  it('imports a remote server with headers', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        mcpServers: {
          example: {
            url: 'https://mcp.example.com/mcp',
            headers: { 'x-api-key': 'secret' },
          },
        },
      }),
    );

    expect(result).toEqual({
      name: 'example',
      transport: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { 'x-api-key': 'secret' },
      notes: [],
    });
  });

  it('converts an mcp-remote launcher into a remote server', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        mcpServers: {
          notion: {
            command: 'npx',
            args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
          },
        },
      }),
    );

    expect(result.transport).toBe('remote');
    expect(result.url).toBe('https://mcp.notion.com/mcp');
    expect(result.headers).toBeUndefined();
    expect(result.notes[0]).toMatch(/mcp-remote launcher/);
  });

  it('carries --header pairs through an mcp-remote conversion', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        command: 'mcp-remote',
        args: [
          'https://mcp.example.com/mcp',
          '--header',
          'x-api-key: secret',
          '--transport',
          'sse-only',
        ],
      }),
    );

    expect(result.transport).toBe('remote');
    expect(result.headers).toEqual({ 'x-api-key': 'secret' });
    expect(result.notes.join(' ')).toContain(
      'Dropped mcp-remote arguments: --transport, sse-only.',
    );
  });

  it('accepts a bare single-entry map without a wrapper', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        example: { command: 'node', args: ['server.js'] },
      }),
    );

    expect(result.name).toBe('example');
    expect(result.stdio?.command).toBe('node');
  });

  it('sanitizes wrapper keys into valid server names', () => {
    const result = parseCustomMcpServerJson(
      JSON.stringify({
        mcpServers: { 'My Notion (Prod)': { url: 'https://x.example/mcp' } },
      }),
    );

    expect(result.name).toBe('my-notion-prod');
  });

  it('rejects snippets with multiple servers', () => {
    expect(() =>
      parseCustomMcpServerJson(
        JSON.stringify({
          mcpServers: {
            one: { command: 'npx' },
            two: { command: 'uvx' },
          },
        }),
      ),
    ).toThrow(/2 servers/);
  });

  it('rejects invalid JSON and configs without command or url', () => {
    expect(() => parseCustomMcpServerJson('not json')).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      parseCustomMcpServerJson(JSON.stringify({ mcpServers: { x: {} } })),
    ).toThrow(/does not contain a server config|command.*nor.*url/);
  });
});

describe('sanitizeCustomMcpServerName', () => {
  it('lowercases and replaces invalid characters', () => {
    expect(sanitizeCustomMcpServerName('Example_Server v2')).toBe(
      'example_server-v2',
    );
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeCustomMcpServerName('***')).toBeNull();
  });
});
