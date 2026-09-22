import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_COMPLETION_GATE_PLUGIN_SCRIPT } from '../opencode-completion-gate-plugin-script';

type ToolHooks = {
  'tool.execute.before': (
    input: { tool: string; args?: unknown },
    context?: { args?: unknown },
  ) => Promise<void>;
};

describe('OPENCODE_COMPLETION_GATE_PLUGIN_SCRIPT', () => {
  let tempDir: string;
  let server: http.Server | undefined;
  const requests: Array<{
    path: string;
    auth: string | undefined;
    body: unknown;
  }> = [];
  let respondWith: { allowed: boolean; reason?: string } = { allowed: true };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-completion-gate-plugin-'),
    );
    requests.length = 0;
    respondWith = { allowed: true };
    process.env.ROOMOTE_COMPLETION_GATE = 'true';
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
  });

  async function startServer(): Promise<void> {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(body),
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { data: { json: respondWith } } }));
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server!.address() as { port: number };
    process.env.ROOMOTE_SANDBOX_SERVER_URL = `http://127.0.0.1:${port}`;
  }

  async function loadHooks(): Promise<ToolHooks> {
    const pluginPath = path.join(tempDir, 'roomote-completion-gate.mjs');
    fs.writeFileSync(
      pluginPath,
      OPENCODE_COMPLETION_GATE_PLUGIN_SCRIPT,
      'utf8',
    );
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    )) as { RoomoteOpenCodeCompletionGate: () => Promise<ToolHooks> };

    return module.RoomoteOpenCodeCompletionGate();
  }

  it('fails a held tool call with the reasons from the sandbox server', async () => {
    await startServer();
    respondWith = { allowed: false, reason: 'Roomote held this report.' };
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before'](
        { tool: 'roomote_report_to_parent_session' },
        { args: { text: 'Done.' } },
      ),
    ).rejects.toThrow('Roomote held this report.');
    expect(requests).toEqual([
      {
        path: '/trpc/commands.checkCompletionBeforeTool',
        auth: 'Bearer run-token',
        body: {
          json: {
            tool: 'roomote_report_to_parent_session',
            args: { text: 'Done.' },
          },
        },
      },
    ]);
  });

  it('lets an allowed call through and skips tools that cannot be a trigger', async () => {
    await startServer();
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before'](
        { tool: 'bash' },
        { args: { command: 'git push origin HEAD' } },
      ),
    ).resolves.toBeUndefined();
    await hooks['tool.execute.before'](
      { tool: 'bash' },
      { args: { command: 'pnpm vitest run' } },
    );
    await hooks['tool.execute.before'](
      { tool: 'read' },
      { args: { filePath: 'a' } },
    );
    expect(requests).toHaveLength(1);
  });

  it('allows the call when the check is off or the server is unreachable', async () => {
    process.env.ROOMOTE_SANDBOX_SERVER_URL = 'http://127.0.0.1:1';
    const unreachable = await loadHooks();

    await expect(
      unreachable['tool.execute.before'](
        { tool: 'bash' },
        { args: { command: 'git push' } },
      ),
    ).resolves.toBeUndefined();

    await startServer();
    process.env.ROOMOTE_COMPLETION_GATE = 'false';
    const off = await loadHooks();
    await off['tool.execute.before'](
      { tool: 'bash' },
      { args: { command: 'git push' } },
    );
    expect(requests).toHaveLength(0);
  });
});
