import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateOpenCodeConfig } from './agent-home';

// Opt-in with RUN_HARNESS_INTEGRATION_TESTS=1; uses the installed OpenCode CLI,
// its native @ai-sdk/openai transport, and a Responses-only upstream.
it('executes a native streamed Responses tool and sends its output back without Chat Completions', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'roomote-responses-'));
  const requests: Array<{
    url?: string;
    body: { input?: Array<Record<string, unknown>> };
  }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push({ url: request.url, body: payload });
      if (request.url !== '/prefix/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      const continuation = payload.input?.some(
        (item: Record<string, unknown>) => item.type === 'function_call_output',
      );
      const call = {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'bash',
        arguments: JSON.stringify({
          command: 'printf responses-tool-ok',
          description: 'Check tool execution',
        }),
        status: 'completed',
      };
      const message = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Responses round trip complete.',
            annotations: [],
          },
        ],
      };
      const meta = {
        id: continuation ? 'resp_2' : 'resp_1',
        object: 'response',
        created_at: 1,
        model: 'custom-model',
        status: 'in_progress',
        output: [],
      };
      const events = [
        { type: 'response.created', response: meta },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: continuation
            ? { ...message, content: [] }
            : { ...call, arguments: '', status: 'in_progress' },
        },
        ...(continuation
          ? [
              {
                type: 'response.content_part.added',
                item_id: 'msg_1',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              },
              {
                type: 'response.output_text.delta',
                item_id: 'msg_1',
                output_index: 0,
                content_index: 0,
                delta: message.content[0]!.text,
              },
              {
                type: 'response.output_text.done',
                item_id: 'msg_1',
                output_index: 0,
                content_index: 0,
                text: message.content[0]!.text,
              },
            ]
          : [
              {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc_1',
                output_index: 0,
                delta: call.arguments.slice(0, 18),
              },
              {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc_1',
                output_index: 0,
                delta: call.arguments.slice(18),
              },
              {
                type: 'response.function_call_arguments.done',
                item_id: 'fc_1',
                output_index: 0,
                arguments: call.arguments,
              },
            ]),
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: continuation ? message : call,
        },
        {
          type: 'response.completed',
          response: {
            ...meta,
            status: 'completed',
            output: [continuation ? message : call],
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              total_tokens: 30,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = events
        .map(
          (event, index) =>
            `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
        )
        .join('');
      response.write(text.slice(0, 83));
      setImmediate(() => response.end(text.slice(83)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing TCP address');
    const generated = generateOpenCodeConfig({
      homeDir: home,
      runtimeEnv: {
        R_MODEL: 'openai-compatible-native/custom-model',
        OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'responses',
        OPENAI_COMPATIBLE_NATIVE_BASE_URL: `http://127.0.0.1:${address.port}/prefix/v1`,
      },
    });
    const config = JSON.parse(generated.configContent);
    // Exercise the generated transport with a minimal local build agent, free
    // from the task's unrelated MCP integrations and workflow instructions.
    const child = spawn(
      'opencode',
      [
        'run',
        '--format',
        'json',
        '--model',
        'openai-compatible-native/custom-model',
        'Run the health-check command and summarize its output.',
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          XDG_CACHE_HOME: home,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: config.provider,
            permission: { '*': 'allow' },
          }),
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      const [code] = await once(child, 'exit');
      expect(code, output).toBe(0);
      expect(output).toContain('Responses round trip complete.');
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(
        requests.every((request) => request.url === '/prefix/v1/responses'),
      ).toBe(true);
      expect(
        requests.some((request) =>
          request.body.input?.some(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'call_1' &&
              String(item.output).includes('responses-tool-ok'),
          ),
        ),
      ).toBe(true);
    } finally {
      clearTimeout(timeout);
      child.kill('SIGKILL');
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 75_000);
