import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { FAST_AGENT_NATIVE_TOOL_NAMES } from '@roomote/types';

import { getFastAgentNativeToolRuntime } from '../fast-agent-native-tool-bridge';

/**
 * Guards the generated Fast native tool schemas before provider conversion.
 *
 * OpenCode loads each generated tool module with its own zod 4, treats
 * `args` as a record of field schemas (wrapping it in `z.object`), and ships
 * `z.toJSONSchema` of that to the provider. A tool that declares `args` as a
 * bare schema instead of a record (a `z.union`, say) turns into a schema
 * carrying zod internals, which OpenAI rejects with
 * `invalid_function_parameters` on every request, taking down every Fast turn
 * on its models. This test mirrors OpenCode's Zod loading, not provider-side
 * normalization or acceptance by a live model endpoint.
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
  return zod.z.toJSONSchema(zod.z.object(args as Record<string, never>), {
    io: 'input',
  });
}

describe('Fast native tool schemas before provider conversion', () => {
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
      'export const invoke = async () => ({ title: "", output: "", metadata: {} });\n',
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

  it('covers every native tool', () => {
    const generated = tools.map((tool) => tool.name).sort();
    for (const name of Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)) {
      expect(generated).toContain(name);
    }
    for (const tool of tools) {
      expect(typeof tool.description, tool.name).toBe('string');
      expect(typeof tool.execute, tool.name).toBe('function');
    }
  });

  it('produces a JSON schema with supported keywords for every tool', () => {
    const failures: string[] = [];
    for (const tool of tools) {
      let schema: unknown;
      try {
        schema = toOpenCodeJsonSchema(zod, tool.args ?? {});
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
      $defs?: Record<string, unknown>;
    };
    const argsSchema = schema.properties?.args as
      | { type?: string; additionalProperties?: { $ref?: string } }
      | undefined;
    const valueSchemaName = argsSchema?.additionalProperties?.$ref?.replace(
      '#/$defs/',
      '',
    );
    const valueSchema = valueSchemaName
      ? (schema.$defs?.[valueSchemaName] as
          | { anyOf?: Array<{ type?: string }> }
          | undefined)
      : undefined;

    expect(argsSchema?.type).toBe('object');
    expect(valueSchema?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'object' }),
        expect.objectContaining({ type: 'array' }),
      ]),
    );

    const validate = new AjvJsonSchemaValidator().getValidator(
      schema as JsonSchemaType,
    );
    const inputSchema = zod.z.object(callTool?.args as Record<string, never>);
    const target = { integrationId: 'example', toolName: 'lookup' };
    const nestedArgs = {
      url: 'https://example.com/issues/123',
      organizationSlug: 'example',
      filter: { values: [null, false, 0, '', { nested: [{ value: 'ok' }] }] },
    };
    for (const args of [nestedArgs, {}, undefined]) {
      const input = { ...target, ...(args === undefined ? {} : { args }) };
      expect(validate(input).valid).toBe(true);
      expect(inputSchema.parse(input)).toEqual(input);
    }
    for (const args of ['not an object', [], 42, true, null]) {
      const input = { ...target, args };
      expect(validate(input).valid).toBe(false);
      expect(inputSchema.safeParse(input).success).toBe(false);
    }
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
