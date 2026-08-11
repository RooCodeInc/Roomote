import { describe, expect, it } from 'vitest';

import { sanitizeProxiedResponseHeaders } from './remote-mcp-proxy';

describe('sanitizeProxiedResponseHeaders', () => {
  it('removes stale body encoding and transport headers', () => {
    const headers = sanitizeProxiedResponseHeaders(
      new Headers({
        connection: 'keep-alive',
        'content-encoding': 'gzip',
        'content-length': '123',
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
      }),
    );

    expect(Object.fromEntries(headers)).toEqual({
      'content-type': 'application/json',
      'mcp-session-id': 'session-1',
    });
  });
});
