import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import {
  NullableOptionalsMcpServer,
  withNullableOptionals,
} from './mcp-nullable-optionals';

describe('withNullableOptionals', () => {
  const shape = withNullableOptionals({
    action: z.enum(['get', 'update']).describe('required action'),
    threadId: z.string().optional().describe('optional thread id'),
    issueNumber: z
      .number()
      .int()
      .refine((value) => value > 0, {
        message: 'Issue number must be positive.',
      })
      .optional(),
    labels: z.array(z.string()).default([]),
    note: z.string().nullable().optional(),
    suggestions: z
      .array(
        z.object({
          label: z.string(),
          priority: z.number().optional(),
          category: z.enum(['fix', 'improve']).optional(),
        }),
      )
      .optional(),
    target: z
      .object({ repo: z.string(), branch: z.string().optional() })
      .optional(),
  });
  const schema = z.object(shape);

  it('maps null on optional fields to undefined for the handler', () => {
    expect(
      schema.parse({
        action: 'get',
        threadId: null,
        issueNumber: null,
        suggestions: null,
        target: null,
      }),
    ).toEqual({
      action: 'get',
      threadId: undefined,
      issueNumber: undefined,
      labels: [],
      suggestions: undefined,
      target: undefined,
    });
  });

  it('applies the default when a defaulted field is null', () => {
    expect(schema.parse({ action: 'get', labels: null }).labels).toEqual([]);
    expect(schema.parse({ action: 'get', labels: ['a'] }).labels).toEqual([
      'a',
    ]);
  });

  it('recurses into nested objects and array elements', () => {
    expect(
      schema.parse({
        action: 'update',
        suggestions: [{ label: 'Fix it', priority: null, category: null }],
        target: { repo: 'acme/web', branch: null },
      }),
    ).toMatchObject({
      suggestions: [
        { label: 'Fix it', priority: undefined, category: undefined },
      ],
      target: { repo: 'acme/web', branch: undefined },
    });
  });

  it('still accepts omitted and real values', () => {
    expect(schema.parse({ action: 'get' })).toEqual({
      action: 'get',
      labels: [],
    });
    expect(
      schema.parse({ action: 'update', threadId: 'T1', issueNumber: 7 }),
    ).toMatchObject({ action: 'update', threadId: 'T1', issueNumber: 7 });
  });

  it('deserializes numeric and boolean transport values before validation', () => {
    expect(
      schema.parse({
        action: 'update',
        issueNumber: '7',
        suggestions: [{ label: 'Fix it', priority: '2' }],
      }),
    ).toMatchObject({
      action: 'update',
      issueNumber: 7,
      suggestions: [{ label: 'Fix it', priority: 2 }],
    });
  });

  it('rejects non-decimal numeric transport values', () => {
    expect(() =>
      schema.parse({ action: 'update', issueNumber: '0x10' }),
    ).toThrow();
    expect(() =>
      schema.parse({ action: 'update', issueNumber: '0b10' }),
    ).toThrow();
    expect(() =>
      schema.parse({ action: 'update', issueNumber: '0o10' }),
    ).toThrow();
  });

  it('keeps inner refinements for non-null values', () => {
    expect(() => schema.parse({ action: 'get', issueNumber: 0 })).toThrow(
      'Issue number must be positive.',
    );
  });

  it('leaves required fields non-nullable', () => {
    expect(() => schema.parse({ action: null })).toThrow();
    expect(() =>
      schema.parse({ action: 'update', suggestions: [{ label: null }] }),
    ).toThrow();
  });

  it('preserves descriptions and does not double-wrap nullable fields', () => {
    expect(shape.threadId.description).toBe('optional thread id');
    expect(shape.action.description).toBe('required action');
    expect((shape.note as z.ZodOptional<z.ZodTypeAny>).unwrap()).toBeInstanceOf(
      z.ZodNullable,
    );
    expect(schema.parse({ action: 'get', note: null }).note).toBeNull();
  });

  it('passes through undefined unchanged', () => {
    expect(withNullableOptionals(undefined)).toBeUndefined();
  });

  it('preserves object and array checks and descriptions while adapting nested fields', () => {
    const original = z
      .object({
        entries: z
          .array(z.object({ name: z.string().optional() }))
          .max(2)
          .describe('bounded entries'),
      })
      .refine((value) => value.entries.length > 0, 'At least one entry')
      .describe('checked object');
    const adapted = withNullableOptionals(original);
    expect(adapted.description).toBe('checked object');
    expect(adapted.shape.entries.description).toBe('bounded entries');
    expect(adapted.parse({ entries: [{ name: null }] })).toEqual({
      entries: [{ name: undefined }],
    });
    expect(adapted.safeParse({ entries: [] }).success).toBe(false);
    expect(adapted.safeParse({ entries: [{}, {}, {}] }).success).toBe(false);
  });

  it('adapts nested discriminated unions and transformed objects', () => {
    const original = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), note: z.string().optional() }),
        z.object({
          kind: z.literal('count'),
          count: z.number().int().optional(),
        }),
      ])
      .transform((value) => ({ ...value, parsed: true }));
    const adapted = withNullableOptionals(original);
    expect(adapted.parse({ kind: 'text', note: null })).toEqual({
      kind: 'text',
      note: undefined,
      parsed: true,
    });
    expect(adapted.parse({ kind: 'count', count: '2' })).toEqual({
      kind: 'count',
      count: 2,
      parsed: true,
    });
    expect(adapted.safeParse({ kind: 'other' }).success).toBe(false);
  });

  it('evaluates a default factory for each null input', () => {
    let next = 0;
    const adapted = withNullableOptionals(
      z.object({ value: z.number().default(() => ++next) }),
    );
    expect(adapted.parse({ value: null }).value).toBe(1);
    expect(adapted.parse({ value: null }).value).toBe(2);
  });
});

describe('NullableOptionalsMcpServer', () => {
  it('advertises null for optional fields and hands handlers undefined', async () => {
    const server = new NullableOptionalsMcpServer({
      name: 'test',
      version: '0.0.0',
    });
    const received: unknown[] = [];
    server.registerTool(
      'echo',
      {
        description: 'echo',
        inputSchema: {
          action: z.string(),
          threadId: z.string().optional().describe('thread'),
          limit: z.number().int().optional(),
          suggestions: z
            .array(
              z.object({ label: z.string(), priority: z.number().optional() }),
            )
            .optional(),
        },
      },
      async (args) => {
        received.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const properties = tools[0]!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(tools[0]!.inputSchema.required).toEqual(['action']);
    expect(properties.action).toEqual({ type: 'string' });
    expect(properties.threadId).toMatchObject({
      type: ['string', 'null'],
      description: 'thread',
    });
    expect(JSON.stringify(properties.limit)).toContain('"null"');
    const items = (
      properties.suggestions!.anyOf as Array<Record<string, unknown>>
    ).find((option) => option.type === 'array')!.items as Record<
      string,
      unknown
    >;
    expect(
      JSON.stringify((items.properties as Record<string, unknown>).priority),
    ).toContain('"null"');

    await client.callTool({
      name: 'echo',
      arguments: {
        action: 'get',
        threadId: null,
        limit: null,
        suggestions: [{ label: 'a', priority: null }],
      },
    });
    expect(received).toEqual([
      {
        action: 'get',
        threadId: undefined,
        limit: undefined,
        suggestions: [{ label: 'a', priority: undefined }],
      },
    ]);

    await client.close();
    await server.close();
  });

  it('deserializes source-control numeric and boolean arguments at the MCP boundary', async () => {
    const server = new NullableOptionalsMcpServer({
      name: 'test',
      version: '0.0.0',
    });
    const received: unknown[] = [];
    server.registerTool(
      'manage_source_control',
      {
        inputSchema: {
          action: z.enum([
            'get_pull_request',
            'update_pull_request_comment',
            'resolve_pull_request_thread',
          ]),
          prNumber: z.number().int().positive(),
          commentId: z.string().optional(),
          resolved: z.boolean().optional(),
        },
      },
      async (args) => {
        received.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const properties = tools[0]!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.prNumber).toMatchObject({ type: 'integer' });
    expect(properties.resolved).toMatchObject({
      type: ['boolean', 'null'],
    });

    await client.callTool({
      name: 'manage_source_control',
      arguments: {
        action: 'get_pull_request',
        prNumber: '12',
      },
    });
    await client.callTool({
      name: 'manage_source_control',
      arguments: {
        action: 'update_pull_request_comment',
        prNumber: '12',
        commentId: '3001',
      },
    });
    await client.callTool({
      name: 'manage_source_control',
      arguments: {
        action: 'resolve_pull_request_thread',
        prNumber: '12',
        resolved: 'false',
      },
    });

    expect(received).toEqual([
      { action: 'get_pull_request', prNumber: 12 },
      {
        action: 'update_pull_request_comment',
        prNumber: 12,
        commentId: '3001',
      },
      {
        action: 'resolve_pull_request_thread',
        prNumber: 12,
        resolved: false,
      },
    ]);

    await client.close();
    await server.close();
  });
});
