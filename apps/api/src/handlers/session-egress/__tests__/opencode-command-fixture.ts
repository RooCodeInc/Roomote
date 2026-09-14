import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Actual OpenCode process; inference is a deterministic local protocol fixture. */
export async function startOpenCodeCommandFixture(
  home: string,
  environment: NodeJS.ProcessEnv,
  command: string,
) {
  let sequence = 0;
  const received: Record<string, unknown>[] = [];
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    received.push(body);
    const last = body.messages?.at(-1);
    const result =
      Array.isArray(last?.content) &&
      last.content.some(
        (part: { type?: string }) => part.type === 'tool_result',
      );
    const callTool =
      body.tools?.some((tool: { name?: string }) => tool.name === 'bash') &&
      !result;
    const id = `fixture-${++sequence}`;
    const content = callTool
      ? {
          type: 'tool_use',
          id: `toolu_${id}`,
          name: 'bash',
          input: {
            command,
            description: 'Inspect scoped fixture configuration',
          },
        }
      : { type: 'text', text: 'Fixture complete' };
    const reason = callTool ? 'tool_use' : 'end_turn';
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [content],
          stop_reason: reason,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const event = (type: string, data: object) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    event('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      index: 0,
      content_block: callTool
        ? { ...content, input: {} }
        : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      index: 0,
      delta: callTool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(content.input),
          }
        : { type: 'text_delta', text: content.text },
    });
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event('message_stop', {});
    res.end();
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  if (!address || typeof address === 'string')
    throw new Error('Model fixture address unavailable');
  const directory = join(home, '.config/opencode');
  const binary = process.env.OPENCODE_TEST_BINARY || 'opencode';
  const version = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
  }).trim();
  const plugin = '@opencode-ai/plugin';
  const pluginDirectory = join(
    directory,
    'node_modules',
    '@opencode-ai',
    'plugin',
  );
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'opencode',
      private: true,
      dependencies: { [plugin]: version },
    }),
  );
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      name: 'opencode',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [plugin]: version } },
        [`node_modules/${plugin}`]: { version },
      },
    }),
  );
  writeFileSync(
    join(pluginDirectory, 'package.json'),
    JSON.stringify({ name: plugin, version, type: 'module', main: 'index.js' }),
  );
  writeFileSync(join(pluginDirectory, 'index.js'), 'export {};\n');
  const child = spawn(
    binary,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: home,
      env: {
        ...environment,
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_STATE_HOME: join(home, 'state'),
        OPENCODE_CONFIG_DIR: directory,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          share: 'disabled',
          enabled_providers: ['anthropic'],
          model: 'anthropic/claude-sonnet-4-5',
          small_model: 'anthropic/claude-sonnet-4-5',
          provider: {
            anthropic: {
              options: {
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'synthetic-fixture-key',
              },
            },
          },
          permission: { '*': 'deny', bash: 'allow' },
          agent: { build: { tools: { '*': false, bash: true } } },
          mcp: {},
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  const close = async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await Promise.race([once(child, 'exit'), delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  };
  try {
    let serverUrl: string | undefined;
    for (let i = 0; i < 200; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error(`Fixture harness exited: ${output.slice(-2000)}`);
      serverUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (serverUrl) break;
      await delay(100);
    }
    if (!serverUrl)
      throw new Error(`Fixture harness did not start: ${output.slice(-2000)}`);
    const created = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Session configuration regression' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) throw new Error('Fixture session creation failed');
    const session = (await created.json()) as { id: string };
    return {
      version,
      received,
      close,
      run: async () => {
        const result = await fetch(
          `${serverUrl}/session/${session.id}/message`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
              parts: [{ type: 'text', text: 'Run the fixture command once.' }],
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!result.ok)
          throw new Error(`Fixture prompt failed (${result.status})`);
        await result.text();
        const messages = (await (
          await fetch(`${serverUrl}/session/${session.id}/message`, {
            signal: AbortSignal.timeout(10_000),
          })
        ).json()) as Array<{
          parts: Array<{
            type: string;
            tool?: string;
            state?: { status: string; output?: string };
          }>;
        }>;
        const calls = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === 'tool' && part.tool === 'bash');
        const last = calls.at(-1);
        if (last?.state?.status !== 'completed')
          throw new Error(
            `Fixture bash did not complete: ${JSON.stringify(last)}`,
          );
        return last.state.output ?? '';
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
