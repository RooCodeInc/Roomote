import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { db, and, eq, isNull, repositories, users } from '@roomote/db/server';
import {
  buildGitLabApiBaseUrl,
  createGitLabMergeRequestNote,
  getGitLabMergeRequest,
  getGitLabOAuthConnection,
  GitLabApiError,
  normalizeGitLabBaseUrl,
  requestGitLab,
  resolveGitLabBaseUrl,
  resolveGitLabOAuthAccessToken,
} from '@roomote/gitlab';
import type { Variables } from '../../../types';

const MAX_BYTES = 1024 * 1024;
class OperationError extends Error {}
const id = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const project = z.union([
  id,
  z.number().int().positive(),
  z.string().regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
]);
const text = z.string().min(1);
const path = text.refine(
  (value) =>
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..'),
);
const pagination = {
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
};
const pageToken = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
const mr = { project_id: project, merge_request_iid: id };
export const schemas = {
  get_file_contents: z.strictObject({
    project_id: project,
    file_path: path,
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
      .optional()
      .describe('Zero-based line offset; default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'Maximum lines; default 2000. Files over 1 MiB are rejected even for a small window.',
      ),
  }),
  get_repository_tree: z.strictObject({
    project_id: project,
    path: path.optional(),
    ref: text.optional(),
    recursive: z.boolean().optional(),
    per_page: pagination.per_page,
    page_token: pageToken.optional(),
    pagination: z
      .literal('keyset')
      .optional()
      .describe(
        'Keyset pagination; pass next_page_token as page_token to continue.',
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
    path: path.optional(),
    ...pagination,
  }),
  get_commit: z.strictObject({ project_id: project, sha: path }),
  get_merge_request: z.strictObject(mr),
  list_merge_request_diffs: z.strictObject({ ...mr, ...pagination }),
  get_merge_request_notes: z.strictObject({ ...mr, ...pagination }),
  mr_discussions: z.strictObject({ ...mr, ...pagination }),
  update_merge_request: z.strictObject({
    ...mr,
    title: text.optional(),
    description: z.string().optional(),
    state_event: z.enum(['close', 'reopen']).optional(),
  }),
  create_merge_request_note: z.strictObject({ ...mr, body: text }),
  create_merge_request_discussion_note: z.strictObject({
    ...mr,
    discussion_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    body: text,
  }),
};
type ToolName = keyof typeof schemas;
const isToolName = (name: string): name is ToolName =>
  Object.hasOwn(schemas, name);
const writes = new Set<ToolName>([
  'update_merge_request',
  'create_merge_request_note',
  'create_merge_request_discussion_note',
]);

export function createGitlabMcp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', bodyLimit({ maxSize: 65536 }));
  app.post('/', async (c) => {
    const auth = c.get('authContext');
    if (!auth || auth.tokenType !== 'auth' || 'runId' in auth || !auth.userId)
      return c.json({ error: 'User authentication required' }, 403);
    const actor = await db.query.users.findFirst({
      where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
    });
    if (!actor || !['member', 'admin'].includes(actor.role))
      return c.json({ error: 'Active member required' }, 403);
    let requestId: string | number | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const rpc = z
        .strictObject({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]).optional(),
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
      if (
        !['https:', 'http:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error('Invalid configuration');
      const checkConnection = (
        connection: Awaited<ReturnType<typeof getGitLabOAuthConnection>>,
      ) => {
        if (
          !connection ||
          connection.status !== 'active' ||
          !connection.scopes.includes('api') ||
          normalizeGitLabBaseUrl(connection.baseUrl) !== baseUrl
        )
          throw new Error('OAuth unavailable');
        return connection;
      };
      const connection = checkConnection(await getGitLabOAuthConnection());
      const value = args ? String(args.project_id) : undefined;
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
      if (!repo) throw new Error('Repository unavailable');
      const projectId = id.parse(repo.externalRepoId);
      if (!call || !args)
        return c.json({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            tools: Object.entries(schemas).map(([name, schema]) => ({
              name,
              description:
                name === 'get_file_contents'
                  ? 'Read a UTF-8 file at an immutable commit, at most 1 MiB and 2000 lines, with continuation metadata.'
                  : name === 'search_project_code'
                    ? 'Search code in this connected project only. Requires instance support for blob search; no unscoped fallback.'
                    : `GitLab ${name.replaceAll('_', ' ')} in an active connected repository.`,
              inputSchema: z.toJSONSchema(schema),
              annotations: {
                readOnlyHint: !writes.has(name as ToolName),
                destructiveHint: writes.has(name as ToolName),
                openWorldHint: true,
              },
            })),
          },
        });
      const token = await resolveGitLabOAuthAccessToken({
        requestTimeoutMs: 10000,
      });
      if (!token) throw new Error('OAuth unavailable');
      const refreshedConnection = checkConnection(
        await getGitLabOAuthConnection(),
      );
      controller.signal.throwIfAborted();
      const options = {
        apiBaseUrl: buildGitLabApiBaseUrl(baseUrl),
        token,
        bounded: true,
        signal: controller.signal,
      };
      const root = `/projects/${projectId}`;
      const mrPath = `${root}/merge_requests/${args.merge_request_iid}`;
      const mrOptions = {
        ...options,
        projectId,
        mergeRequestIid: Number(args.merge_request_iid),
      };
      const read = async (suffix: string) =>
        (
          await requestGitLab({ ...options, path: mrPath + suffix }, [200])
        ).json();
      if (writes.has(call.name as ToolName)) {
        const details = await getGitLabMergeRequest(mrOptions);
        if (
          String(details.project_id) !== projectId ||
          String(details.iid) !== args.merge_request_iid ||
          !Number.isSafeInteger(details.id) ||
          Number(details.id) <= 0
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
                note.noteable_id === details.id &&
                String(note.noteable_iid) === args.merge_request_iid,
            )
          )
            throw new Error('Ownership mismatch');
        }
      }
      let payload: unknown;
      if (call.name === 'get_file_contents') {
        const input = schemas.get_file_contents.parse(args);
        let content: string;
        try {
          const response = await requestGitLab(
            {
              ...options,
              path: `${root}/repository/files/${encodeURIComponent(input.file_path)}/raw`,
              params: { ref: input.ref, lfs: false },
              accept: 'text/plain',
            },
            [200],
          );
          // Response.text() strips a BOM; keep the original file bytes here.
          content = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(await response.arrayBuffer());
          if (content.includes('\0')) throw new Error('Binary file');
        } catch {
          throw new OperationError(
            'File read failed: the file may be unavailable, exceed the 1 MiB limit, or not be valid UTF-8 text. No file content was returned.',
          );
        }
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const offset = input.offset ?? 0;
        const selected = lines.slice(offset, offset + (input.limit ?? 2000));
        const nextOffset = Math.min(offset + selected.length, lines.length);
        payload = {
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
      } else if (call.name === 'get_merge_request') {
        payload = await getGitLabMergeRequest(mrOptions);
      } else if (call.name === 'create_merge_request_note') {
        payload = await createGitLabMergeRequestNote({
          ...mrOptions,
          body: String(args.body),
        });
      } else {
        let path: string;
        let method: 'GET' | 'POST' | 'PUT' = 'GET';
        let body: Record<string, unknown> | undefined;
        const params: Record<string, string | number | boolean> = {};
        const paged = [
          'get_repository_tree',
          'search_project_code',
          'list_commits',
          'list_merge_request_diffs',
          'get_merge_request_notes',
          'mr_discussions',
        ].includes(call.name);
        if (paged) {
          params.per_page = Number(args.per_page ?? 20);
          if (call.name !== 'get_repository_tree')
            params.page = Number(args.page ?? 1);
        }
        switch (call.name) {
          case 'get_repository_tree':
            path = `${root}/repository/tree`;
            params.pagination = 'keyset';
            break;
          case 'search_project_code':
            path = `${root}/search`;
            params.scope = 'blobs';
            break;
          case 'list_commits':
            path = `${root}/repository/commits`;
            break;
          case 'get_commit':
            path = `${root}/repository/commits/${encodeURIComponent(String(args.sha))}`;
            break;
          case 'list_merge_request_diffs':
            path = `${mrPath}/diffs`;
            break;
          case 'get_merge_request_notes':
            path = `${mrPath}/notes`;
            break;
          case 'mr_discussions':
            path = `${mrPath}/discussions`;
            break;
          case 'update_merge_request':
            path = mrPath;
            method = 'PUT';
            body = Object.fromEntries(
              ['title', 'description', 'state_event']
                .filter((key) => args[key] !== undefined)
                .map((key) => [key, args[key]]),
            );
            break;
          case 'create_merge_request_discussion_note':
            path = `${mrPath}/discussions/${args.discussion_id}/notes`;
            method = 'POST';
            body = { body: args.body };
            break;
          default:
            throw new Error('Unsupported tool');
        }
        for (const key of [
          'path',
          'ref',
          'recursive',
          'page_token',
          'search',
          'ref_name',
        ]) {
          const value = args[key];
          if (typeof value === 'string' || typeof value === 'boolean')
            params[key] = value;
        }
        let response: Response;
        try {
          response = await requestGitLab(
            { ...options, path, params, method, body },
            [200, 201],
          );
        } catch (error) {
          if (
            call.name === 'search_project_code' &&
            error instanceof GitLabApiError &&
            [400, 403, 404, 405, 501].includes(error.status)
          )
            throw new OperationError(
              'Project code search is unavailable on this GitLab instance or for this connection. No unscoped search was attempted.',
            );
          throw error;
        }
        const data: unknown = await response.json();
        if (paged) {
          if (!Array.isArray(data) || data.length > Number(params.per_page))
            throw new Error('Invalid page');
          if (call.name === 'get_repository_tree') {
            // Extract only the cursor. Never fetch or expose provider-supplied URLs.
            const link = response.headers
              .get('link')
              ?.split(',')
              .find((part) => /;\s*rel="next"/.test(part));
            const next = link?.match(/<([^>]+)>/)?.[1];
            const cursor = next
              ? new URL(next, options.apiBaseUrl).searchParams.get('page_token')
              : null;
            payload = {
              items: data,
              next_page_token: cursor ? pageToken.parse(cursor) : null,
            };
          } else {
            const next = response.headers.get('x-next-page');
            payload = {
              items: data,
              next_page: next ? Number(id.parse(next)) : null,
            };
          }
        } else payload = data;
      }
      const text = JSON.stringify(payload);
      const result = { content: [{ type: 'text', text }] };
      const envelope = { jsonrpc: '2.0', id: requestId, result };
      const serialized = JSON.stringify(envelope);
      const secrets = [
        token,
        connection.accessToken,
        connection.refreshToken,
        connection.clientSecret,
        refreshedConnection.accessToken,
        refreshedConnection.refreshToken,
        refreshedConnection.clientSecret,
      ];
      if (
        Buffer.byteLength(serialized) > MAX_BYTES ||
        secrets.some(
          (secret) =>
            secret && text.includes(JSON.stringify(secret).slice(1, -1)),
        )
      )
        throw new OperationError(
          'GitLab output exceeds the response limit or cannot be returned safely. Request a smaller page or line window. No successful result was received.',
        );
      return c.json(envelope);
    } catch (error) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32000,
            message:
              error instanceof OperationError
                ? error.message
                : 'GitLab operation unavailable, unsupported, or outside the permitted scope. No successful result was received.',
          },
        },
        400,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  });
  return app;
}
