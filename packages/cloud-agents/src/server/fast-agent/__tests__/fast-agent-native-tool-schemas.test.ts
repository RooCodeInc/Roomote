import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  CALL_INTEGRATION_TOOL_TOOL,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  serviceCredentialPrepareSchema,
  serviceCredentialPrepareToolSchema,
  MANAGE_WAKEUPS_TOOL,
} from '@roomote/types';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { getFastAgentNativeToolRuntime } from '../fast-agent-native-tool-bridge';
import { writeOpenCodePluginSeedFixture } from '../../__tests__/helpers/opencode-plugin-seed-fixture';

/**
 * Guards the JSON schema OpenAI receives for every Fast native tool.
 *
 * OpenCode loads each generated tool module with its own zod 4, treats
 * `args` as a record of field schemas (wrapping it in `z.object`), and
 * normalizes `z.toJSONSchema` before sending it to the provider. A tool
 * that declares `args` as a
 * bare schema instead of a record (a `z.union`, say) turns into a schema
 * carrying zod internals, which OpenAI rejects with
 * `invalid_function_parameters` on every request, taking down every Fast turn
 * on its models. This test mirrors OpenCode's loading so that shape, and any
 * other construct OpenAI's validator refuses, fails here first.
 */

// The JSON Schema vocabulary OpenAI's function-parameter validator accepts
// (non-strict mode). Anything else is a smell worth failing on.
const ALLOWED_KEYWORDS = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'nullable',
  '$ref',
  '$defs',
  'definitions',
  'propertyNames',
  'uniqueItems',
  'examples',
]);
const ALLOWED_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function validateJsonSchema(node: unknown, path: string): string[] {
  const problems: string[] = [];
  if (typeof node === 'boolean') return problems;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return [`${path}: schema must be an object, got ${typeof node}`];
  }
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      problems.push(`${path}: unexpected keyword "${key}"`);
      continue;
    }
    if (typeof value === 'function') {
      problems.push(`${path}.${key}: functions never serialize`);
      continue;
    }
    switch (key) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        for (const type of types) {
          if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
            problems.push(
              `${path}.type: "${String(type)}" is not a JSON Schema type`,
            );
          }
        }
        break;
      }
      case 'properties':
      case '$defs':
      case 'definitions':
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          problems.push(`${path}.${key}: must be an object`);
          break;
        }
        for (const [name, child] of Object.entries(value)) {
          problems.push(...validateJsonSchema(child, `${path}.${key}.${name}`));
        }
        break;
      case 'items':
      case 'not':
      case 'propertyNames':
        problems.push(...validateJsonSchema(value, `${path}.${key}`));
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') {
          problems.push(...validateJsonSchema(value, `${path}.${key}`));
        }
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        if (!Array.isArray(value)) {
          problems.push(`${path}.${key}: must be an array`);
          break;
        }
        value.forEach((child, index) => {
          problems.push(
            ...validateJsonSchema(child, `${path}.${key}[${index}]`),
          );
        });
        break;
      case 'required': {
        const properties = (node as { properties?: Record<string, unknown> })
          .properties;
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          problems.push(`${path}.required: must be an array of strings`);
        } else if (properties) {
          for (const name of value) {
            if (!(name in properties)) {
              problems.push(
                `${path}.required: "${name}" is not a declared property`,
              );
            }
          }
        }
        break;
      }
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) {
          problems.push(`${path}.enum: must be a non-empty array`);
        }
        break;
      default:
        break;
    }
  }
  return problems;
}

type ZodV4 = typeof import('zod/v4');
type LoadedTool = {
  name: string;
  args: unknown;
  description: unknown;
  execute: unknown;
};

/**
 * OpenCode's registry logic for a plugin tool's `args`: every entry must be
 * a zod schema (detected by `_zod`), then the record is wrapped in
 * `z.object` and converted with `z.toJSONSchema`.
 */
function toOpenCodeJsonSchema(zod: ZodV4, args: unknown) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('args must be a plain object');
  }
  const entries = Object.entries(args);
  const nonZod = entries.filter(
    ([, value]) =>
      !(typeof value === 'object' && value !== null && '_zod' in value),
  );
  if (nonZod.length > 0) {
    throw new Error(
      `args must be a record of zod field schemas, but ${nonZod
        .map(([key]) => `"${key}"`)
        .join(
          ', ',
        )} ${nonZod.length === 1 ? 'is' : 'are'} not. OpenCode wraps args in z.object itself; a bare schema (z.union, z.object) as args ships its internals to the provider.`,
    );
  }
  const schema = zod.z.toJSONSchema(
    zod.z.object(args as Record<string, never>),
    {
      io: 'input',
    },
  );
  // OpenCode v1.18.10 tool/registry.ts zodJsonSchema renames the dictionary
  // without rewriting refs. Testing raw Zod output missed this boundary.
  const { $defs, ...rest } = schema;
  return JSON.parse(
    JSON.stringify($defs ? { ...rest, definitions: $defs } : rest),
  );
}

describe('Fast native tool schemas as OpenAI receives them', () => {
  const validator = new Ajv2020({ strict: false }).addFormat(
    'uuid',
    (value: string) => z.string().uuid().safeParse(value).success,
  );
  let workDir: string;
  let zod: ZodV4;
  let tools: LoadedTool[];

  beforeAll(async () => {
    const runtime = await getFastAgentNativeToolRuntime('tool-schemas', []);
    const sourceToolsDir = join(runtime.env.OPENCODE_CONFIG_DIR!, 'tools');

    // Evaluate the generated modules the way OpenCode does: with zod 4 and a
    // bridge stub. The temp tree carries its own `zod` package so the bare
    // `import { z } from "zod"` in each tool resolves to the same zod 4 this
    // test converts with.
    workDir = await mkdtemp(join(tmpdir(), 'roomote-tool-schemas-'));
    const require = createRequire(import.meta.url);
    const zodV4Entry = require.resolve('zod/v4');
    await mkdir(join(workDir, 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(workDir, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', type: 'module', exports: './index.js' }),
    );
    await writeFile(
      join(workDir, 'node_modules', 'zod', 'index.js'),
      `export * from ${JSON.stringify(pathToFileURL(zodV4Entry).href)};\n`,
    );
    await writeFile(
      join(workDir, 'roomote-fast-tool-bridge.js'),
      'export const invoke = async (name, args) => ({ name, args });\n',
    );
    await cp(sourceToolsDir, join(workDir, 'tools'), { recursive: true });
    zod = await import(pathToFileURL(zodV4Entry).href);

    const files = (await readdir(join(workDir, 'tools'))).filter((file) =>
      file.endsWith('.js'),
    );
    tools = await Promise.all(
      files.map(async (file) => {
        const mod = (await import(
          pathToFileURL(join(workDir, 'tools', file)).href
        )) as {
          default: Omit<LoadedTool, 'name'>;
        };
        return { name: file.replace(/\.js$/u, ''), ...mod.default };
      }),
    );
  });

  afterAll(async () => {
    if (workDir)
      await rm(dirname(join(workDir, 'x')), { recursive: true, force: true });
  });

  it('generates concrete nonsecret preparation and empty status schemas', async () => {
    const prepare = tools.find(
      ({ name }) =>
        name === FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential,
    )!;
    const status = tools.find(
      ({ name }) =>
        name === FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials,
    )!;
    const schema = toOpenCodeJsonSchema(zod, prepare.args!);
    expect(Object.keys(prepare.args!).sort()).toEqual([
      'allowedMethods',
      'headerName',
      'headerPrefix',
      'label',
      'lifetimeHours',
      'origin',
      'visibility',
    ]);
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        origin: { type: 'string', minLength: 1, maxLength: 2048 },
        headerName: { type: 'string', minLength: 1, maxLength: 64 },
        headerPrefix: {
          enum: ['Bearer', 'Basic', 'Token', 'Bearer ', 'Basic ', 'Token '],
        },
        lifetimeHours: { type: 'integer', minimum: 1, maximum: 8760 },
        allowedMethods: {
          type: 'array',
          items: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          minItems: 1,
          maxItems: 6,
        },
        visibility: { enum: ['owner', 'deployment'] },
      },
    });
    expect(schema.required).not.toContain('allowedMethods');
    expect(schema.required).not.toContain('headerPrefix');
    expect(JSON.stringify(schema)).not.toContain('"enum":[""');
    expect(status.args).toEqual({});
    expect(toOpenCodeJsonSchema(zod, status.args!)).toMatchObject({
      type: 'object',
      properties: {},
    });
    const args = {
      label: 'API',
      origin: 'https://api.example.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
    };
    expect(serviceCredentialPrepareSchema.parse(args)).toEqual({
      ...args,
      allowedMethods: ['GET', 'HEAD'],
      visibility: 'deployment',
    });
    expect(
      serviceCredentialPrepareToolSchema.parse({
        label: 'API',
        origin: 'https://api.example.com',
        headerName: 'x-api-key',
      }),
    ).toEqual({
      label: 'API',
      origin: 'https://api.example.com',
      headerName: 'x-api-key',
      headerPrefix: '',
      allowedMethods: ['GET', 'HEAD'],
      visibility: 'deployment',
    });
    expect(
      serviceCredentialPrepareSchema.parse({
        ...args,
        allowedMethods: ['POST', 'GET'],
      }).allowedMethods,
    ).toEqual(['GET', 'POST']);
    for (const extra of [
      { secret: 'never-a-key' },
      { userId: 'caller' },
      { sessionId: 'caller' },
      { lifetimeHours: 0 },
      { lifetimeHours: 8761 },
      { lifetimeHours: 1.5 },
      { headerName: 'cookie' },
      { headerPrefix: 'Custom ' },
      { allowedMethods: [] },
      { allowedMethods: ['GET', 'GET'] },
      { allowedMethods: ['OPTIONS'] },
    ]) {
      expect(
        serviceCredentialPrepareToolSchema.safeParse({ ...args, ...extra })
          .success,
      ).toBe(false);
    }
    expect(
      serviceCredentialPrepareSchema.parse({ ...args, headerPrefix: '' })
        .headerPrefix,
    ).toBe('');
    for (const [tool, input] of [
      [prepare, args],
      [status, {}],
    ] as const) {
      const execute = tool.execute as (
        args: unknown,
        context: unknown,
      ) => Promise<unknown>;
      expect(await execute(input, {})).toEqual({
        name: tool.name,
        args: input,
      });
    }
  });

  it('exposes only nonsecret arguments for adding a remote MCP', async () => {
    const tool = tools.find(
      ({ name }) => name === FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp,
    )!;
    const schema = toOpenCodeJsonSchema(zod, tool.args!);

    expect(tool.description).toContain(
      'use that exact integrationId with find_integration_tools and call_integration_tool',
    );
    expect(tool.description).toContain(
      "a service's official hosted remote MCP endpoint",
    );
    expect(tool.description).toContain(
      'mean the MCP exists and setup is pending',
    );

    expect(Object.keys(tool.args!).sort()).toEqual(['name', 'url']);
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        url: {
          type: 'string',
          format: 'uri',
          pattern: '^https:\\/\\/.*',
          maxLength: 2048,
        },
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /secret|token|header|client[_-]?id/i,
    );
  });

  it('keeps integration-key tool descriptions aware of the remote MCP route', () => {
    const prepare = tools.find(
      ({ name }) =>
        name === FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential,
    )!;
    const list = tools.find(
      ({ name }) =>
        name === FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials,
    )!;

    expect(prepare.description).toContain('Call list_integration_keys first');
    expect(list.description).toContain('official remote MCP, or skill covers');
  });

  it('covers every enabled native tool', () => {
    const generated = tools.map((tool) => tool.name).sort();
    expect(generated).toEqual(
      Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).sort(),
    );
    for (const tool of tools) {
      expect(typeof tool.description, tool.name).toBe('string');
      expect(typeof tool.execute, tool.name).toBe('function');
    }
  });

  // Opt in where the pinned OpenCode binary is installed. No real provider
  // credentials/config are inherited; both providers terminate at this mock.
  it.skipIf(process.env.ROOMOTE_TEST_OPENCODE_SCHEMAS !== '1')(
    'captures enabled Integration-key setup schemas emitted to OpenAI and Anthropic',
    async () => {
      const requests: Record<string, unknown>[] = [];
      const provider = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        // A non-retryable response stops the turn after capturing serialization.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'Controlled schema capture',
            },
          }),
        );
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const address = provider.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing mock address');
      const baseURL = `http://127.0.0.1:${address.port}/v1`;
      const home = join(workDir, 'isolated-home');
      await mkdir(home, { recursive: true });
      // Tools import the real Zod installed above, not the plugin. Satisfy
      // OpenCode's install check without contacting the package registry.
      writeOpenCodePluginSeedFixture(workDir, '1.18.10');
      writeOpenCodePluginSeedFixture(
        join(home, 'config', 'opencode'),
        '1.18.10',
      );
      const server = spawn(
        'opencode',
        ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', '0'],
        {
          cwd: home,
          detached: true,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: join(home, 'config'),
            XDG_DATA_HOME: join(home, 'data'),
            XDG_CACHE_HOME: join(home, 'cache'),
            XDG_STATE_HOME: join(home, 'state'),
            OPENCODE_CONFIG_DIR: workDir,
            OPENCODE_DISABLE_PROJECT_CONFIG: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              enabled_providers: ['openai', 'anthropic'],
              share: 'disabled',
              provider: {
                openai: { options: { baseURL, apiKey: 'mock-provider-key' } },
                anthropic: {
                  options: { baseURL, apiKey: 'mock-provider-key' },
                },
              },
              agent: {
                build: {
                  tools: {
                    '*': false,
                    prepare_integration_key: true,
                    list_integration_keys: true,
                  },
                },
              },
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let spawnError: Error | undefined;
      server.on('error', (error) => {
        spawnError = error;
      });
      server.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      server.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      try {
        await vi.waitFor(
          () => {
            if (spawnError) throw spawnError;
            expect(server.exitCode, output).toBeNull();
            expect(output).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
          },
          { timeout: 20_000 },
        );
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
        for (const [providerID, modelID] of [
          ['openai', 'gpt-4.1'],
          ['anthropic', 'claude-sonnet-4-5'],
        ]) {
          requests.length = 0;
          const sessionResponse = await fetch(`${url}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Controlled schema capture' }),
            signal: AbortSignal.timeout(20_000),
          });
          expect(sessionResponse.ok, output).toBe(true);
          const session = (await sessionResponse.json()) as { id: string };
          await fetch(`${url}/session/${session.id}/message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: { providerID, modelID },
              parts: [
                {
                  type: 'text',
                  text: 'Read /status using secret reference e9d35700-56b8-4bf0-b088-c1cb498905d9.',
                },
              ],
            }),
            signal: AbortSignal.timeout(20_000),
          });
          for (const [name, properties] of [
            [
              FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential,
              {
                label: { type: 'string' },
                origin: { type: 'string' },
                headerName: { enum: ['authorization', 'x-api-key', 'api-key'] },
                headerPrefix: {
                  enum: [
                    'Bearer',
                    'Basic',
                    'Token',
                    'Bearer ',
                    'Basic ',
                    'Token ',
                  ],
                },
                lifetimeHours: { type: 'integer' },
                allowedMethods: { type: 'array' },
              },
            ],
            [FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials, {}],
          ] as const) {
            const tool = requests
              .flatMap(
                (request) =>
                  (request.tools ?? []) as Array<{
                    name?: string;
                    parameters?: object;
                    input_schema?: object;
                  }>,
              )
              .find((tool) => tool.name === name);
            expect(tool, `${providerID}: ${name}: ${output}`).toBeDefined();
            const schema =
              providerID === 'anthropic'
                ? tool!.input_schema
                : tool!.parameters;
            expect(schema).toMatchObject({ type: 'object', properties });
            if (
              name === FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential
            ) {
              expect(
                (schema as { required?: string[] }).required,
              ).not.toContain('headerPrefix');
            }
            expect(
              Object.keys((schema as { properties: object }).properties).sort(),
            ).toEqual(Object.keys(properties).sort());
            expect(validateJsonSchema(schema, providerID!)).toEqual([]);
          }
          expect(JSON.stringify(requests)).not.toContain('mock-provider-key');
        }
      } catch (error) {
        throw new Error(`OpenCode schema capture failed: ${output}`, {
          cause: error,
        });
      } finally {
        if (
          server.pid &&
          server.exitCode === null &&
          server.signalCode === null
        ) {
          process.kill(-server.pid, 'SIGKILL');
          await once(server, 'exit');
        }
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      }
    },
    90_000,
  );

  it('produces a JSON schema OpenAI accepts for every tool', () => {
    const failures: string[] = [];
    for (const tool of tools) {
      let schema: unknown;
      try {
        schema = toOpenCodeJsonSchema(zod, tool.args ?? {});
        validator.compile(schema as object);
      } catch (error) {
        failures.push(
          `${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const problems = validateJsonSchema(schema, tool.name);
      const root = schema as { type?: unknown; properties?: unknown };
      if (root.type !== 'object' || typeof root.properties !== 'object') {
        problems.push(
          `${tool.name}: root must be an object schema with properties`,
        );
      }
      failures.push(...problems);
    }
    expect(failures).toEqual([]);
  });

  it('accepts only canonical pull request review overrides', () => {
    const reviewTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.reviewPullRequest,
    );
    const schema = zod.z.object(reviewTool?.args as Record<string, never>);

    expect(
      schema.safeParse({
        kickoffMessage: 'Reviewing this now.',
        model: 'anthropic/claude-sonnet-5',
        reasoningEffort: 'xhigh',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kickoffMessage: 'Reviewing this now.',
        reasoningEffort: 'extreme',
      }).success,
    ).toBe(false);
  });

  it('exposes integration call args as an object with arbitrary JSON values', () => {
    const callTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
    );
    const schema = toOpenCodeJsonSchema(zod, callTool?.args ?? {}) as {
      properties?: Record<string, unknown>;
    };
    const argsSchema = schema.properties?.args as
      | { type?: string; additionalProperties?: { anyOf?: unknown[] } }
      | undefined;

    expect(argsSchema?.type).toBe('object');
    expect(argsSchema?.additionalProperties?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'object' }),
        expect.objectContaining({ type: 'array' }),
      ]),
    );
  });

  it('detects dangling refs after OpenCode normalizes recursive Zod schemas', () => {
    const args = {
      args: zod.z.record(zod.z.string(), zod.z.json()).optional(),
    };
    expect(() =>
      validator.compile(
        zod.z.toJSONSchema(zod.z.object(args), { io: 'input' }),
      ),
    ).not.toThrow();
    expect(() => validator.compile(toOpenCodeJsonSchema(zod, args))).toThrow(
      /can't resolve reference #\/\$defs\//,
    );
  });

  it('preserves nested JSON through serialized native schema validation and server parsing', () => {
    const callTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
    )!;
    const validate = validator.compile(
      toOpenCodeJsonSchema(zod, callTool.args),
    );
    const nativeSchema = zod.z.object(callTool.args as Record<string, never>);
    const serverSchema = z.object(CALL_INTEGRATION_TOOL_TOOL.inputSchema);
    const base = { integrationId: 'example', toolName: 'nested_tool' };
    for (const args of [
      {},
      {
        text: 'value',
        number: 1.5,
        enabled: true,
        nullable: null,
        list: [
          null,
          false,
          42,
          'text',
          [],
          {},
          { nested: [{ 'arbitrary/key': { values: [1, null] } }] },
        ],
        object: { nested: { list: [[{ value: 'preserved' }]] } },
      },
    ]) {
      const input = JSON.parse(JSON.stringify({ ...base, args }));
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(nativeSchema.parse(input)).toEqual(input);
      expect(serverSchema.parse(input)).toEqual(input);
    }
    for (const args of [null, 'text', [], 42, false]) {
      expect(validate({ ...base, args })).toBe(false);
    }
    // Omitting args is rejected too: the field is required so the provider
    // schema never carries a null alternative.
    expect(validate(base)).toBe(false);
    expect(serverSchema.safeParse(base).success).toBe(false);
  });

  it('preserves required Sentry organization scope through generated tool execution and server parsing', async () => {
    const callTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
    )!;
    const request = {
      integrationId: 'sentry',
      toolName: 'search_issues',
      args: {
        organizationSlug: 'example-org',
        query: 'lastSeen:-24h',
        projectSlugOrId: 'example-project',
      },
    };
    const parsed = zod.z
      .object(callTool.args as Record<string, never>)
      .parse(request);
    const execute = callTool.execute as (
      args: unknown,
      context: unknown,
    ) => Promise<{ name: string; args: unknown }>;
    const forwarded = await execute(parsed, {});
    expect(forwarded.name).toBe(
      FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
    );
    expect(
      z.object(CALL_INTEGRATION_TOOL_TOOL.inputSchema).parse(forwarded.args),
    ).toEqual(request);
  });

  it('forwards explicit internal wakeup visibility', async () => {
    const wakeupsTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.manageWakeups,
    )!;
    const request = {
      action: 'create',
      name: 'Follow through on session tasks',
      prompt: 'Check the tasks in this conversation.',
      schedule: 'in 10m',
      reportPolicy: 'only_when_notable',
      internal: true,
    };
    const parsed = zod.z
      .object(wakeupsTool.args as Record<string, never>)
      .parse(request);
    const execute = wakeupsTool.execute as (
      args: unknown,
      context: unknown,
    ) => Promise<{ name: string; args: unknown }>;
    const forwarded = await execute(parsed, {});

    expect(parsed).toHaveProperty('internal', true);
    expect(wakeupsTool.args).toHaveProperty('internal');
    expect(forwarded.name).toBe(FAST_AGENT_NATIVE_TOOL_NAMES.manageWakeups);
    expect(
      z.object(MANAGE_WAKEUPS_TOOL.inputSchema).parse(forwarded.args),
    ).toEqual({
      action: 'create',
      name: request.name,
      prompt: request.prompt,
      schedule: request.schedule,
      reportPolicy: request.reportPolicy,
      internal: true,
    });
  });

  // Synthetic arguments verify the generic bridge, not live upstream schemas.
  it.each([
    { toolName: 'sources', args: {} },
    { toolName: 'sources', args: { name: 'example', page: 2, per_page: 10 } },
    { toolName: 'source', args: { id: 42 } },
    {
      toolName: 'query',
      args: {
        source_id: 42,
        table: 'observed_logs_7',
        host: 'cluster.example.test',
        query: 'SELECT count() FROM observed_logs_7',
      },
    },
    {
      toolName: 'query',
      args: { source_id: 42, table: 'observed_logs_7', query: 'SELECT 1' },
    },
  ])(
    'preserves Better Stack $toolName arguments without defaults through generated execution',
    async ({ toolName, args }) => {
      const callTool = tools.find(
        (tool) =>
          tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
      )!;
      const request = JSON.parse(
        JSON.stringify({ integrationId: 'betterstack', toolName, args }),
      );
      const validate = validator.compile(
        toOpenCodeJsonSchema(zod, callTool.args),
      );
      expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
      const parsed = zod.z
        .object(callTool.args as Record<string, never>)
        .parse(request);
      expect(parsed).toEqual(request);
      const execute = callTool.execute as (
        args: unknown,
        context: unknown,
      ) => Promise<{ name: string; args: unknown }>;
      const forwarded = await execute(parsed, {});
      expect(forwarded.name).toBe(
        FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool,
      );
      expect(
        z.object(CALL_INTEGRATION_TOOL_TOOL.inputSchema).parse(forwarded.args),
      ).toEqual(request);
    },
  );
  it('preserves discovery prose preferences through the native bridge', async () => {
    const inputTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput,
    )!;
    const request = {
      preset: 'setup_integrations',
      setupIntegrationAnswers: { communication: { answers: ['Slack'] } },
    };
    const parsed = zod.z
      .object(inputTool.args as Record<string, never>)
      .parse(request);
    const execute = inputTool.execute as (
      args: unknown,
      context: unknown,
    ) => Promise<{ name: string; args: unknown }>;
    expect(await execute(parsed, {})).toEqual({
      name: 'request_user_input',
      args: request,
    });
  });

  it('preserves bounded trusted capability offer arguments', async () => {
    const offerTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.offerCapability,
    )!;
    const request = {
      capability: 'source_control',
      message: 'Connect GitHub so I can retrieve the event from your code.',
      provider: 'github',
    };
    const parsed = zod.z
      .object(offerTool.args as Record<string, never>)
      .parse(request);
    const execute = offerTool.execute as (
      args: unknown,
      context: unknown,
    ) => Promise<{ name: string; args: unknown }>;
    expect(await execute(parsed, {})).toEqual({
      name: 'offer_capability',
      args: request,
    });
  });

  it('tolerates null placeholders for optional capability offer arguments', async () => {
    const offerTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.offerCapability,
    )!;
    const parsed = zod.z.object(offerTool.args as Record<string, never>).parse({
      capability: 'source_control',
      message: 'Connect source control so I can work with your code.',
      provider: null,
      integrationIds: null,
    });
    const execute = offerTool.execute as (
      args: unknown,
      context: unknown,
    ) => Promise<{ name: string; args: Record<string, unknown> }>;

    const forwarded = await execute(parsed, {});

    expect(forwarded.name).toBe('offer_capability');
    expect(forwarded.args.provider).toBeUndefined();
    expect(forwarded.args.integrationIds).toBeUndefined();
  });

  it('defaults omitted display metadata on structured questions', async () => {
    const inputTool = tools.find(
      (tool) => tool.name === FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput,
    )!;
    const parsed = zod.z.object(inputTool.args as Record<string, never>).parse({
      // Models sometimes send unused optional values as placeholders. This
      // mirrors the setup payload from the regression report.
      preset: null,
      setupIntegrationAnswers: [],
      questions: [
        {
          id: 'team-knowledge',
          question: 'Where do you keep team documents and knowledge?',
          options: [{ label: 'Notion' }],
        },
      ],
    });
    expect(parsed).toMatchObject({
      questions: [
        {
          header: 'Question',
          options: [{ label: 'Notion', description: 'Select this option.' }],
        },
      ],
    });
    expect(parsed.preset).toBeUndefined();
    expect(parsed.setupIntegrationAnswers).toBeUndefined();
  });

  it('rejects a bare union or object as args, the shape that broke OpenAI models', () => {
    const { z } = zod;
    const question = z.object({ id: z.string() });
    expect(() =>
      toOpenCodeJsonSchema(
        zod,
        z.union([
          z.object({ questions: z.array(question) }).strict(),
          z.object({ preset: z.enum(['setup_starter_tasks']) }).strict(),
        ]),
      ),
    ).toThrow(/record of zod field schemas/u);
    expect(() =>
      toOpenCodeJsonSchema(zod, z.object({ questions: z.array(question) })),
    ).toThrow(/record of zod field schemas/u);
    // The corrected record shape converts cleanly.
    expect(
      validateJsonSchema(
        toOpenCodeJsonSchema(zod, {
          questions: z.array(question).optional(),
          preset: z.enum(['setup_starter_tasks']).optional(),
        }),
        'request_user_input',
      ),
    ).toEqual([]);
  });

  it('flags schema constructs outside the accepted vocabulary', () => {
    expect(
      validateJsonSchema(
        { type: 'object', properties: { a: { type: 'union' } } },
        't',
      ),
    ).toEqual(['t.properties.a.type: "union" is not a JSON Schema type']);
    expect(
      validateJsonSchema(
        { type: 'object', properties: {}, required: ['missing'] },
        't',
      ),
    ).toEqual(['t.required: "missing" is not a declared property']);
    expect(
      validateJsonSchema(
        { type: 'object', properties: { a: { _zod: {} } } },
        't',
      ),
    ).toEqual(['t.properties.a: unexpected keyword "_zod"']);
  });
});
