import { and, db, eq, isNull, repositories, users } from '@roomote/db/server';
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
import {
  gitLabPageTokenSchema,
  gitLabToolSchemas,
  gitLabWriteTools,
  type GitLabToolInput,
  type GitLabToolName,
} from './schemas';

const MAX_BYTES = 1024 * 1024;

export class GitLabOperationError extends Error {}

export type GitLabMcpContext = {
  baseUrl: string;
  host: string;
};

function checkConnection(
  connection: Awaited<ReturnType<typeof getGitLabOAuthConnection>>,
  baseUrl: string,
) {
  if (
    !connection ||
    connection.status !== 'active' ||
    !connection.scopes.includes('api') ||
    normalizeGitLabBaseUrl(connection.baseUrl) !== baseUrl
  ) {
    throw new Error('OAuth unavailable');
  }
  return connection;
}

export async function authorizeGitLabMcp(
  auth: Variables['authContext'],
): Promise<GitLabMcpContext> {
  if (!auth || auth.tokenType !== 'auth' || 'runId' in auth || !auth.userId) {
    throw new GitLabOperationError('User authentication required');
  }

  const actor = await db.query.users.findFirst({
    where: and(eq(users.id, auth.userId), isNull(users.deletedAt)),
  });
  if (!actor || !['member', 'admin'].includes(actor.role)) {
    throw new GitLabOperationError('Active member required');
  }

  const baseUrl = await resolveGitLabBaseUrl();
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid configuration');
  }

  checkConnection(await getGitLabOAuthConnection(), baseUrl);
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitlab'),
      eq(repositories.host, base.host),
      eq(repositories.isActive, true),
    ),
  });
  if (!repository) throw new Error('Repository unavailable');

  return { baseUrl, host: base.host };
}

function safeToolResult(payload: unknown, secrets: Array<string | null>) {
  const text = JSON.stringify(payload);
  const result = { content: [{ type: 'text' as const, text }] };
  const envelope = JSON.stringify({ jsonrpc: '2.0', id: null, result });

  if (
    Buffer.byteLength(envelope) > MAX_BYTES ||
    secrets.some(
      (secret) => secret && text.includes(JSON.stringify(secret).slice(1, -1)),
    )
  ) {
    throw new GitLabOperationError(
      'GitLab output exceeds the response limit or cannot be returned safely. Request a smaller page or line window. No successful result was received.',
    );
  }

  return result;
}

export async function executeGitLabTool(
  context: GitLabMcpContext,
  name: GitLabToolName,
  input: GitLabToolInput,
) {
  const args = input as Record<string, unknown>;
  const value = String(args.project_id);
  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitlab'),
      eq(repositories.host, context.host),
      eq(repositories.isActive, true),
      /^[1-9][0-9]*$/.test(value)
        ? eq(repositories.externalRepoId, value)
        : eq(repositories.fullName, value),
    ),
  });
  if (!repo) throw new Error('Repository unavailable');

  const projectId =
    gitLabToolSchemas.get_merge_request.shape.merge_request_iid.parse(
      repo.externalRepoId,
    );
  const connection = checkConnection(
    await getGitLabOAuthConnection(),
    context.baseUrl,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const token = await resolveGitLabOAuthAccessToken({
      requestTimeoutMs: 10000,
    });
    if (!token) throw new Error('OAuth unavailable');
    const refreshedConnection = checkConnection(
      await getGitLabOAuthConnection(),
      context.baseUrl,
    );
    controller.signal.throwIfAborted();

    const options = {
      apiBaseUrl: buildGitLabApiBaseUrl(context.baseUrl),
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

    if (gitLabWriteTools.has(name)) {
      const details = await getGitLabMergeRequest(mrOptions);
      if (
        String(details.project_id) !== projectId ||
        String(details.iid) !== args.merge_request_iid ||
        !Number.isSafeInteger(details.id) ||
        Number(details.id) <= 0
      ) {
        throw new Error('Ownership mismatch');
      }
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
        ) {
          throw new Error('Ownership mismatch');
        }
      }
    }

    let payload: unknown;
    if (name === 'get_file_contents') {
      const fileInput = gitLabToolSchemas.get_file_contents.parse(args);
      let content: string;
      try {
        const response = await requestGitLab(
          {
            ...options,
            path: `${root}/repository/files/${encodeURIComponent(fileInput.file_path)}/raw`,
            params: { ref: fileInput.ref, lfs: false },
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
        throw new GitLabOperationError(
          'File read failed: the file may be unavailable, exceed the 1 MiB limit, or not be valid UTF-8 text. No file content was returned.',
        );
      }
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const offset = fileInput.offset ?? 0;
      const selected = lines.slice(offset, offset + (fileInput.limit ?? 2000));
      const nextOffset = Math.min(offset + selected.length, lines.length);
      payload = {
        project_id: projectId,
        file_path: fileInput.file_path,
        ref: fileInput.ref,
        size_bytes: Buffer.byteLength(content),
        total_lines: lines.length,
        offset,
        lines_returned: selected.length,
        next_offset: nextOffset < lines.length ? nextOffset : null,
        truncated: offset > 0 || nextOffset < lines.length,
        content: selected.join(''),
      };
    } else if (name === 'get_merge_request') {
      payload = await getGitLabMergeRequest(mrOptions);
    } else if (name === 'create_merge_request_note') {
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
      ].includes(name);
      if (paged) {
        params.per_page = Number(args.per_page ?? 20);
        if (name !== 'get_repository_tree')
          params.page = Number(args.page ?? 1);
      }
      switch (name) {
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
        if (typeof value === 'string' || typeof value === 'boolean') {
          params[key] = value;
        }
      }
      let response: Response;
      try {
        response = await requestGitLab(
          { ...options, path, params, method, body },
          [200, 201],
        );
      } catch (error) {
        if (
          name === 'search_project_code' &&
          error instanceof GitLabApiError &&
          [400, 403, 404, 405, 501].includes(error.status)
        ) {
          throw new GitLabOperationError(
            'Project code search is unavailable on this GitLab instance or for this connection. No unscoped search was attempted.',
          );
        }
        throw error;
      }
      const data: unknown = await response.json();
      if (paged) {
        if (!Array.isArray(data) || data.length > Number(params.per_page)) {
          throw new Error('Invalid page');
        }
        if (name === 'get_repository_tree') {
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
            next_page_token: cursor
              ? gitLabPageTokenSchema.parse(cursor)
              : null,
          };
        } else {
          const next = response.headers.get('x-next-page');
          payload = {
            items: data,
            next_page: next
              ? Number(
                  gitLabToolSchemas.get_merge_request.shape.merge_request_iid.parse(
                    next,
                  ),
                )
              : null,
          };
        }
      } else {
        payload = data;
      }
    }

    return safeToolResult(payload, [
      token,
      connection.accessToken,
      connection.refreshToken,
      connection.clientSecret,
      refreshedConnection.accessToken,
      refreshedConnection.refreshToken,
      refreshedConnection.clientSecret,
    ]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
