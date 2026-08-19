import { createServer } from 'node:http';

import { listMcpTools } from '../mcp-tool-client';

describe('MCP tool client cancellation', () => {
  it('aborts the initialization transport when discovery is cancelled', async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let markRequestClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => {
      markRequestClosed = resolve;
    });
    const server = createServer((request) => {
      markRequestStarted();
      request.once('aborted', markRequestClosed);
      request.once('close', markRequestClosed);
      // Deliberately leave MCP initialization unanswered until the caller
      // aborts, reproducing a nonresponsive integration proxy.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test MCP server did not receive a TCP address.');
    }

    try {
      const abortController = new AbortController();
      const discovery = listMcpTools({
        url: `http://127.0.0.1:${address.port}/mcp`,
        signal: abortController.signal,
      });
      const rejected = expect(discovery).rejects.toThrow();
      await requestStarted;

      abortController.abort(new Error('test discovery timeout'));

      await rejected;
      await Promise.race([
        requestClosed,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('MCP request remained open after abort.')),
            1_000,
          );
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
