import { z } from 'zod';
import { githubPublicTools } from './github-public-tools';
import { McpProxyError } from './proxy-utils';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

/** Anonymous operations on github.com only; never accepts or acquires credentials. */
export async function githubPublicResponse(
  request: unknown,
  httpRequest: Request,
  target?: { owner: string; repo: string },
): Promise<Response> {
  if (httpRequest.method !== 'POST')
    throw new McpProxyError(
      405,
      'Public GitHub MCP uses stateless POST requests',
    );
  const parsed = rpcSchema.safeParse(request);
  if (!parsed.success)
    throw new McpProxyError(400, 'Invalid GitHub MCP request');
  const rpc = parsed.data;
  const reply = (result: unknown) =>
    Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  if (
    rpc.method === 'notifications/initialized' ||
    rpc.method === 'notifications/cancelled'
  )
    return new Response(null, { status: 202 });
  if (rpc.id === undefined || rpc.id === null)
    throw new McpProxyError(400, 'GitHub MCP requests require an id');
  if (rpc.method === 'initialize') {
    const requestedVersion = rpc.params?.protocolVersion;
    return reply({
      protocolVersion: [
        '2025-11-25',
        '2025-06-18',
        '2025-03-26',
        '2024-11-05',
      ].includes(String(requestedVersion))
        ? requestedVersion
        : '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-public', version: '0.32.0' },
    });
  }
  if (rpc.method === 'ping') return reply({});
  if (rpc.method === 'tools/list') return reply({ tools: githubPublicTools });
  if (rpc.method !== 'tools/call' || !target)
    throw new McpProxyError(400, 'Unsupported public GitHub MCP method');
  const name = rpc.params?.name;
  if (name === 'search_code')
    throw new McpProxyError(
      400,
      'Anonymous GitHub code search is unsupported. Use get_file_contents with an exact public repository path.',
    );
  const tool = githubPublicTools.find((candidate) => candidate.name === name);
  if (!tool)
    throw new McpProxyError(
      400,
      'This GitHub tool is unsupported for unconnected public repositories',
    );
  const argumentsResult = z
    .record(z.unknown())
    .safeParse(rpc.params?.arguments);
  if (!argumentsResult.success)
    throw new McpProxyError(400, 'Invalid public GitHub tool arguments');
  const args = argumentsResult.data;
  // These pinned upstream schemas are flat primitive properties. Validate the
  // same contracts, then add transport bounds without changing discovery schemas.
  for (const required of tool.inputSchema.required ?? []) {
    if (args[required] === undefined)
      throw new McpProxyError(400, `Missing GitHub argument: ${required}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = tool.inputSchema.properties?.[key] as
      | { type?: string; enum?: unknown[]; minimum?: number; maximum?: number }
      | undefined;
    if (
      !property ||
      typeof value !== property.type ||
      (property.enum && !property.enum.includes(value)) ||
      (typeof value === 'string' &&
        (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) ||
      (typeof value === 'number' &&
        (!Number.isSafeInteger(value) ||
          value < (property.minimum ?? 1) ||
          value > (property.maximum ?? Number.MAX_SAFE_INTEGER)))
    )
      throw new McpProxyError(400, `Invalid public GitHub argument: ${key}`);
  }
  const page = args.page ?? 1;
  if (Number(page) > 1000)
    throw new McpProxyError(
      400,
      'Public GitHub page must be between 1 and 1000',
    );
  const perPage = args.perPage ?? 30;
  const pagination = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  const root = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  let endpoint = root;
  let accept = 'application/vnd.github+json';
  let query = new URLSearchParams();
  const method = args.method;
  if (name === 'get_file_contents') {
    const path = String(args.path ?? '/').replace(/^\//, '');
    if (
      path &&
      path
        .split('/')
        .some(
          (part) =>
            part === '.' || part === '..' || !part || /[\\%]/.test(part),
        )
    )
      throw new McpProxyError(
        400,
        'Public GitHub contents require an exact repository-relative path without traversal',
      );
    const ref = String(args.sha || args.ref || '');
    if (ref.length > 1024 || /[\\%?#\s~^:*[]|\.\.|@\{/.test(ref))
      throw new McpProxyError(400, 'Invalid public GitHub ref');
    endpoint = `${root}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    if (ref) query.set('ref', ref);
  } else if (name === 'issue_read') {
    const suffix = {
      get: '',
      get_comments: '/comments',
      get_sub_issues: '/sub_issues',
      get_labels: '/labels',
    }[String(method)];
    endpoint = `${root}/issues/${args.issue_number}${suffix}`;
    if (suffix) query = pagination;
  } else if (name === 'pull_request_read') {
    if (method === 'get_review_comments')
      throw new McpProxyError(
        400,
        'Public PR review threads are unsupported: the native get_review_comments contract requires authenticated GraphQL. Use get_reviews for reviews or get_comments for ordinary discussion.',
      );
    const suffix = {
      get: '',
      get_diff: '',
      get_status: '',
      get_check_runs: '',
      get_files: '/files',
      get_reviews: '/reviews',
      get_comments: '/comments',
    }[String(method)];
    endpoint =
      method === 'get_comments'
        ? `${root}/issues/${args.pullNumber}/comments`
        : `${root}/pulls/${args.pullNumber}${suffix}`;
    if (suffix) query = pagination;
    if (method === 'get_diff') accept = 'application/vnd.github.diff';
  } else if (name === 'list_pull_requests') {
    endpoint = `${root}/pulls`;
    query = pagination;
    for (const key of ['state', 'head', 'base', 'sort', 'direction'])
      if (args[key] !== undefined) query.set(key, String(args[key]));
  } else {
    endpoint = '/search/issues';
    query = pagination;
    query.set('q', `${args.query} is:pr`);
    for (const key of ['sort', 'order'])
      if (args[key] !== undefined) query.set(key, String(args[key]));
  }

  const signal = AbortSignal.any([
    httpRequest.signal,
    AbortSignal.timeout(15_000),
  ]);
  let remainingBytes = MAX_RESPONSE_BYTES;
  async function get(
    path: string,
    params = new URLSearchParams(),
    mediaType = 'application/vnd.github+json',
  ): Promise<string> {
    const url = new URL(`https://api.github.com${path}`);
    url.search = params.toString();
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: mediaType,
        'X-GitHub-Api-Version': '2022-11-28',
        'user-agent': 'Roomote-public-github',
      },
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      let message = `Anonymous GitHub read failed (HTTP ${response.status}); no authenticated retry is permitted`;
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers.get('retry-after') ?? '';
        const reset = response.headers.get('x-ratelimit-reset') ?? '';
        const rateLimited =
          response.status === 429 ||
          response.headers.get('x-ratelimit-remaining') === '0' ||
          /^\d{1,5}$/.test(retryAfter);
        message += rateLimited
          ? '. GitHub rate limit reached.'
          : '. GitHub may be denying access or applying a rate limit.';
        message +=
          ' Anonymous requests share the outbound IP limit (normally 60 requests/hour; search has separate, lower limits).';
        if (/^\d{1,5}$/.test(retryAfter) && Number(retryAfter) <= 86400)
          message += ` Retry after ${Number(retryAfter)} seconds.`;
        if (
          /^\d{1,10}$/.test(reset) &&
          Number(reset) > 0 &&
          Number(reset) <= 4102444800
        )
          message += ` Rate limit reset: ${new Date(Number(reset) * 1000).toISOString()}.`;
      }
      throw new McpProxyError(
        response.status >= 400 && response.status < 500 ? response.status : 502,
        message,
      );
    }
    if (Number(response.headers.get('content-length')) > remainingBytes) {
      void response.body?.cancel().catch(() => {});
      throw new McpProxyError(
        413,
        'Public GitHub response exceeds the 2 MiB limit',
      );
    }
    if (!response.body)
      throw new McpProxyError(502, 'Empty public GitHub response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        remainingBytes -= value.byteLength;
        if (remainingBytes < 0)
          throw new McpProxyError(
            413,
            'Public GitHub response exceeds the 2 MiB limit',
          );
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
  try {
    // This anonymous, authoritative visibility check precedes every operation.
    // Never use cached DB visibility, installation credentials, or returned URLs.
    const metadata = z
      .object({ private: z.literal(false), full_name: z.string() })
      .safeParse(JSON.parse(await get(root)));
    if (
      !metadata.success ||
      metadata.data.full_name.toLowerCase() !==
        `${target.owner}/${target.repo}`.toLowerCase()
    )
      throw new McpProxyError(
        403,
        'GitHub repository is not confirmed public on github.com',
      );
    let text = await get(endpoint, query, accept);
    if (
      name === 'pull_request_read' &&
      (method === 'get_status' || method === 'get_check_runs')
    ) {
      const head = z
        .object({
          head: z.object({ sha: z.string().regex(/^[a-fA-F0-9]{40}$/) }),
        })
        .safeParse(JSON.parse(text));
      if (!head.success)
        throw new McpProxyError(502, 'Invalid public GitHub PR head');
      text = await get(
        `${root}/commits/${head.data.head.sha}/${method === 'get_status' ? 'status' : 'check-runs'}`,
        pagination,
      );
    }
    const result =
      accept === 'application/vnd.github.diff'
        ? text
        : (JSON.parse(text) as unknown);
    if (name === 'get_file_contents' && !Array.isArray(result)) {
      const file = z
        .object({
          type: z.literal('file'),
          encoding: z.literal('base64'),
          content: z.string(),
          size: z.number().nonnegative(),
          sha: z.string(),
        })
        .safeParse(result);
      if (!file.success)
        throw new McpProxyError(
          400,
          'Public GitHub file content is unavailable or too large; external downloads and submodule traversal are not supported',
        );
      const bytes = Buffer.from(file.data.content, 'base64');
      if (bytes.length !== file.data.size)
        throw new McpProxyError(502, 'Incomplete public GitHub file content');
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new McpProxyError(
          400,
          'Public GitHub source reads support UTF-8 text files only',
        );
      }
      return reply({
        content: [
          { type: 'text', text: `File SHA: ${file.data.sha}\n${text}` },
        ],
      });
    }
    return reply({
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    });
  } catch (error) {
    if (error instanceof McpProxyError) throw error;
    throw new McpProxyError(
      signal.aborted ? 504 : 502,
      signal.aborted
        ? 'Public GitHub read timed out or was cancelled'
        : 'Public GitHub read failed; no authenticated retry is permitted',
    );
  }
}
