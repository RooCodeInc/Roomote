import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { db, and, eq, isNull, repositories, users } from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  buildGitLabApiBaseUrl,
  getGitLabOAuthConnection,
  normalizeGitLabBaseUrl,
  requestGitLab,
  resolveGitLabBaseUrl,
  resolveGitLabOAuthAccessToken,
} from '@roomote/gitlab';
import type { Variables } from '../../../types';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;
// Both production server constructors use server/version.ts -> package.json.
const UPSTREAM_VERSION = '2.1.60';
class FileReadError extends Error {}
const id = z.string().regex(/^[1-9][0-9]{0,14}$/);
const project = z.union([
  id,
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .max(512)
    .regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
]);
const text = z.string().min(1).max(1024);
const pagination = {
  page: z.number().int().min(1).max(1000).optional(),
  per_page: z.number().int().min(1).max(50).optional(),
};
const mr = { project_id: project, merge_request_iid: id };
// Narrowed from zereight/gitlab-mcp v2.1.60, commit
// bd9be9bde20b3254b2d4b59dc203a19a5d52e5d5. No global GraphQL tools.
export const schemas = {
  get_file_contents: z.strictObject({
    project_id: project,
    file_path: text.refine(
      (path) =>
        !/[\\\x00-\x1f\x7f]/.test(path) &&
        path
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..'),
    ),
    ref: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .describe(
        'Full immutable commit SHA. Resolve a branch with get_commit first.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('Zero-based line offset; default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'Maximum lines returned; default 2000. Files over 1 MiB are rejected, even for a small window.',
      ),
  }),
  get_repository_tree: z.strictObject({
    project_id: project,
    path: text.optional(),
    ref: text.optional(),
    recursive: z.boolean().optional(),
    per_page: pagination.per_page,
    page_token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_+/=-]+$/)
      .optional(),
    pagination: z
      .literal('keyset')
      .optional()
      .describe(
        'Keyset pagination is always used; pass next_page_token as page_token to continue.',
      ),
  }),
  search_project_code: z.strictObject({
    project_id: project,
    search: text,
    ref: text.optional(),
    ...pagination,
  }),
  list_commits: z.strictObject({
    project_id: project,
    ref_name: text.optional(),
    path: text.optional(),
    ...pagination,
  }),
  get_commit: z.strictObject({ project_id: project, sha: text }),
  get_merge_request: z.strictObject(mr),
  list_merge_request_diffs: z.strictObject({ ...mr, ...pagination }),
  get_merge_request_notes: z.strictObject({ ...mr, ...pagination }),
  mr_discussions: z.strictObject({ ...mr, ...pagination }),
  update_merge_request: z.strictObject({
    ...mr,
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(32000).optional(),
    state_event: z.enum(['close', 'reopen']).optional(),
  }),
  create_merge_request_note: z.strictObject({
    ...mr,
    body: z.string().min(1).max(32000),
  }),
  create_merge_request_discussion_note: z.strictObject({
    ...mr,
    discussion_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    body: z.string().min(1).max(32000),
  }),
};
type ToolName = keyof typeof schemas;
const isToolName = (name: string): name is ToolName =>
  Object.hasOwn(schemas, name);

// Refuse incompatible catalogs rather than guessing a renamed operation or schema.
export function compatible(tool: Tool): boolean {
  if (!isToolName(tool.name) || tool.inputSchema.type !== 'object')
    return false;
  if (
    Object.keys(tool.inputSchema).some(
      (key) =>
        ![
          'type',
          'properties',
          'required',
          'additionalProperties',
          '$schema',
          'description',
          'title',
        ].includes(key),
    )
  )
    return false;
  // Only the bounded file fallback consumes these two local-only fields.
  const local = z.toJSONSchema(
    tool.name === 'get_file_contents'
      ? schemas.get_file_contents.omit({ offset: true, limit: true })
      : schemas[tool.name],
  );
  const properties = tool.inputSchema.properties ?? {};
  // The SDK strips nonstandard confirmationHint annotations, but preserves
  // the _confirmed input that the pinned server injects for approval policies.
  if (Object.hasOwn(properties, '_confirmed')) return false;
  if (
    (tool.inputSchema.required ?? []).some(
      (key) => !local.required?.includes(key),
    )
  )
    return false;
  return Object.entries(local.properties ?? {}).every(([key, value]) => {
    const upstream = properties[key] as Record<string, unknown> | undefined;
    if (!upstream || typeof value === 'boolean') return false;
    const type =
      key === 'project_id'
        ? 'string'
        : value.type === 'integer'
          ? 'number'
          : value.type;
    if (upstream.type !== type) return false;
    if (
      Object.keys(upstream).some(
        (key) =>
          !['type', 'description', 'default', 'title', 'enum'].includes(key),
      )
    )
      return false;
    return (
      !Array.isArray(upstream.enum) ||
      (Array.isArray(value.enum) &&
        value.enum.every(
          (entry) =>
            upstream.enum instanceof Array && upstream.enum.includes(entry),
        ))
    );
  });
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks),
  );
}

function guardedFetch(
  target: URL,
  signal: AbortSignal,
  token: string,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== target.origin ||
      !(
        url.pathname === target.pathname ||
        url.pathname.startsWith(`${target.pathname.replace(/\/$/, '')}/`)
      )
    )
      throw new Error('Invalid target');
    const headers = new Headers(init?.headers);
    headers.delete('private-token');
    headers.delete('job-token');
    headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      headers,
    });
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error('Response too large');
    }
    let bytes = 0;
    return new Response(
      response.body?.pipeThrough(
        new TransformStream({
          transform(chunk: Uint8Array, controller) {
            bytes += chunk.byteLength;
            if (bytes > MAX_BYTES) throw new Error('Response too large');
            controller.enqueue(chunk);
          },
        }),
      ),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

export function createGitlabMcp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', bodyLimit({ maxSize: 65536 }));
  app.post('/', async (c) => {
    const auth = c.get('authContext');
    if (!auth || auth.tokenType !== 'auth' || !auth.userId)
      return c.json({ error: 'User authentication required' }, 403);
    const actor = await db.query.users.findFirst({
      where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
    });
    if (!actor || actor.deletedAt || !['member', 'admin'].includes(actor.role))
      return c.json({ error: 'Active member required' }, 403);
    // Operator-only configuration; never derive the upstream from caller input.
    const upstreamUrl = Env.GITLAB_MCP_SERVER_URL;
    if (!upstreamUrl)
      return c.json({ error: 'GitLab MCP is not configured' }, 404);
    let requestId: string | number | null = null;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const rpc = z
        .strictObject({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string().max(128), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional(),
        })
        .parse(await c.req.json());
      requestId = rpc.id ?? null;
      if (rpc.method === 'notifications/initialized') return c.body(null, 202);
      if (rpc.method === 'initialize')
        return c.json({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'roomote-gitlab', version: '1.0.0' },
          },
        });
      if (!['tools/list', 'tools/call'].includes(rpc.method))
        throw new Error('Unsupported method');
      const call =
        rpc.method === 'tools/call'
          ? z
              .strictObject({ name: z.string(), arguments: z.unknown() })
              .parse(rpc.params)
          : undefined;
      if (!call) z.strictObject({}).parse(rpc.params ?? {});
      if (call && !isToolName(call.name)) throw new Error('Unsupported tool');
      const args: Record<string, unknown> | undefined =
        call && isToolName(call.name)
          ? schemas[call.name].parse(call.arguments)
          : undefined;
      if (call?.name === 'get_repository_tree' && args)
        args.pagination = 'keyset';
      if (
        call?.name === 'update_merge_request' &&
        args &&
        !['title', 'description', 'state_event'].some(
          (key) => args[key] !== undefined,
        )
      )
        throw new Error('Empty update');
      const baseUrl = await resolveGitLabBaseUrl();
      const base = new URL(baseUrl);
      const upstream = new URL(upstreamUrl);
      if (
        ![base, upstream].every(
          (url) =>
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash,
        )
      )
        throw new Error('Invalid configuration');
      const connection = await getGitLabOAuthConnection();
      if (
        !connection ||
        connection.status !== 'active' ||
        !connection.scopes.includes('api') ||
        normalizeGitLabBaseUrl(connection.baseUrl) !== baseUrl
      )
        throw new Error('OAuth unavailable');
      const value = args ? String(args.project_id) : undefined;
      // Discovery also uses a connected project scope, never an unrestricted token context.
      const repo = await db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, 'gitlab'),
          eq(repositories.host, base.host),
          eq(repositories.isActive, true),
          value === undefined
            ? undefined
            : /^[1-9][0-9]*$/.test(value)
              ? eq(repositories.externalRepoId, value)
              : eq(repositories.fullName, value),
        ),
      });
      if (
        !repo ||
        !repo.isActive ||
        repo.host !== base.host ||
        repo.sourceControlProvider !== 'gitlab' ||
        (value !== undefined &&
          repo.externalRepoId !== value &&
          repo.fullName !== value)
      )
        throw new Error('Repository unavailable');
      const projectId = id.parse(repo.externalRepoId);
      if (args) args.project_id = projectId;
      const token = await resolveGitLabOAuthAccessToken({
        requestTimeoutMs: 10000,
      });
      if (!token) throw new Error('OAuth unavailable');
      const apiBaseUrl = buildGitLabApiBaseUrl(baseUrl);
      if (
        args &&
        [
          'update_merge_request',
          'create_merge_request_note',
          'create_merge_request_discussion_note',
        ].includes(call!.name)
      ) {
        const path = `/projects/${projectId}/merge_requests/${args.merge_request_iid}`;
        const read = async (suffix: string) =>
          JSON.parse(
            await boundedBody(
              await requestGitLab(
                {
                  apiBaseUrl,
                  path: path + suffix,
                  token,
                  signal: controller.signal,
                  fetchImpl: guardedFetch(
                    new URL(apiBaseUrl),
                    controller.signal,
                    token,
                  ),
                },
                [200],
              ),
            ),
          ) as Record<string, unknown>;
        const mrObject = await read('');
        if (
          String(mrObject.project_id) !== projectId ||
          String(mrObject.iid) !== args.merge_request_iid ||
          !Number.isSafeInteger(mrObject.id) ||
          Number(mrObject.id) <= 0
        )
          throw new Error('Ownership mismatch');
        if (args.discussion_id) {
          const discussion = await read(`/discussions/${args.discussion_id}`);
          if (
            discussion.id !== args.discussion_id ||
            !Array.isArray(discussion.notes) ||
            !discussion.notes.length ||
            !discussion.notes.every(
              (note: Record<string, unknown>) =>
                note.noteable_type === 'MergeRequest' &&
                note.noteable_id === mrObject.id &&
                String(note.noteable_iid) === args.merge_request_iid,
            )
          )
            throw new Error('Ownership mismatch');
        }
      }
      client = new Client({ name: 'roomote-gitlab', version: '1.0.0' });
      transport = new StreamableHTTPClientTransport(upstream, {
        fetch: guardedFetch(upstream, controller.signal, token),
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-GitLab-API-URL': apiBaseUrl,
            'X-GitLab-Allowed-Project-Ids': projectId,
          },
        },
      });
      await client.connect(transport, {
        signal: controller.signal,
        timeout: TIMEOUT_MS,
      });
      if (client.getServerVersion()?.version !== UPSTREAM_VERSION)
        throw new Error('Unsupported upstream version');
      const catalog = await client.listTools(
        {},
        { signal: controller.signal, timeout: TIMEOUT_MS },
      );
      if (catalog.nextCursor) throw new Error('Unsupported paginated catalog');
      const tools = catalog.tools.filter(compatible);
      if (!call)
        return c.json({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description:
                tool.name === 'get_file_contents'
                  ? 'Read a UTF-8 file at an immutable commit in an active connected repository. Rejects files over 1 MiB. Returns up to 2000 lines with explicit continuation metadata.'
                  : `GitLab ${tool.name.replaceAll('_', ' ')} in an active connected repository.`,
              inputSchema: z.toJSONSchema(schemas[tool.name as ToolName]),
            })),
          },
        });
      if (!tools.some((tool) => tool.name === call.name))
        throw new Error('Unsupported upstream capability');
      let result;
      if (call.name === 'get_file_contents') {
        // The pinned MCP downloads the entire file without a pre-download bound.
        // Keep only this operation on the existing GitLab REST client; cap bytes
        // while streaming raw content, and require a SHA so line windows cannot drift.
        const input = schemas.get_file_contents.parse(args);
        let content: string;
        try {
          content = await boundedBody(
            await requestGitLab(
              {
                apiBaseUrl,
                path: `/projects/${projectId}/repository/files/${encodeURIComponent(input.file_path)}/raw`,
                params: { ref: input.ref, lfs: false },
                token,
                accept: 'text/plain',
                signal: controller.signal,
                fetchImpl: guardedFetch(
                  new URL(apiBaseUrl),
                  controller.signal,
                  token,
                ),
              },
              [200],
            ),
          );
        } catch {
          throw new FileReadError(
            'File read failed: the file may be unavailable, exceed the 1 MiB limit, or not be valid UTF-8. No file content was returned.',
          );
        }
        if (content.includes('\0'))
          throw new FileReadError(
            'Binary files are not supported. No file content was returned.',
          );
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 2000;
        const selected = lines.slice(offset, offset + limit);
        const nextOffset = Math.min(offset + selected.length, lines.length);
        const payload = {
          project_id: projectId,
          file_path: input.file_path,
          ref: input.ref,
          size_bytes: Buffer.byteLength(content),
          total_lines: lines.length,
          offset,
          lines_returned: selected.length,
          next_offset: nextOffset < lines.length ? nextOffset : null,
          truncated: offset > 0 || nextOffset < lines.length,
          content: selected.join(''),
        };
        result = {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        };
      } else
        result = await client.callTool(
          { name: call.name, arguments: args },
          undefined,
          { signal: controller.signal, timeout: TIMEOUT_MS },
        );
      if (result.isError) throw new Error('Upstream operation failed');
      const serialized = JSON.stringify(result);
      if (
        Buffer.byteLength(serialized) > MAX_BYTES ||
        serialized.includes(token)
      )
        throw call.name === 'get_file_contents'
          ? new FileReadError(
              'File output exceeds the response limit or cannot be returned safely. Request a smaller line window. No file content was returned.',
            )
          : new Error('Unsafe response');
      return c.json({ jsonrpc: '2.0', id: requestId, result });
    } catch (error) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32000,
            message:
              error instanceof FileReadError
                ? error.message
                : 'GitLab operation unavailable, unsupported, or outside the permitted scope. No successful result was received.',
          },
        },
        400,
      );
    } finally {
      if (transport?.sessionId && !controller.signal.aborted) {
        const cleanupTimer = setTimeout(() => controller.abort(), 1000);
        try {
          await transport.terminateSession();
        } catch {
          /* Best-effort cleanup after an upstream failure. */
        }
        clearTimeout(cleanupTimer);
      }
      controller.abort();
      clearTimeout(timer);
      await client?.close().catch(() => {});
    }
  });
  return app;
}
