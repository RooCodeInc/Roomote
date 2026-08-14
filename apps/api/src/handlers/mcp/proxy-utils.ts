import { Hono } from 'hono';

import {
  filterMcpToolDefinitions,
  formatSingleLineLog,
  getEffectiveAllowedMcpToolNames,
  type RunTokenContext,
  isMcpToolAllowed,
  isUserToken,
  parseMcpJsonRpcPayload,
} from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';
import { Agent } from 'undici';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';

import type { Variables } from '../../types';
import { fetchWithLongLivedStreamDispatcher } from '../long-lived-fetch';
import { createLoggedProxyResponseBody } from '../proxy-response-stream';

type JsonRpcRequestId = string | number | null;

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  id: JsonRpcRequestId = null,
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

function getJsonRpcRequestId(body: unknown): JsonRpcRequestId {
  if (!body || typeof body !== 'object' || !('id' in body)) {
    return null;
  }

  const { id } = body as { id?: unknown };
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

export function hasRealTaskRunUser(
  userId: string | null | undefined,
): userId is string {
  return typeof userId === 'string' && userId.trim().length > 0;
}

export function toMcpToolResult<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

/**
 * Resolve the effective user for downstream MCP credential lookup.
 *
 * Run tokens are authorized by their run binding (runId); integration
 * MCPs execute as the most recent human who launched or replied to the task.
 * That live actor is stored on `task_runs.actingUserId` rather than inferred
 * from `task_messages`, because transcript persistence is async and may lag
 * behind the turn that is about to make MCP calls. The token's own userId is
 * mint-time attribution and deliberately plays no role here.
 *
 * Since this column selects whose credentials MCP calls run as, it is written
 * only by trusted server-side actors (web steer, follow-up delivery). Job
 * tokens cannot reassign it — `taskRuns.update` strips `actingUserId` from
 * run-token input — so a compromised sandbox cannot steer MCP calls to
 * another user's connections.
 */
export async function resolveActingUserId(
  auth: McpAuthContext,
): Promise<string> {
  if (auth.tokenType !== 'run') {
    if (!hasRealTaskRunUser(auth.userId)) {
      throw new McpProxyError(
        403,
        'This MCP requires a human actor; the request is authenticated as the deployment service principal',
      );
    }
    return auth.userId;
  }

  if (!auth.runId) {
    throw new McpProxyError(
      403,
      'MCP proxy requires a task run token with a task run id',
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: { actingUserId: true },
    where: eq(taskRuns.id, auth.runId),
  });

  if (!taskRun) {
    throw new McpProxyError(404, 'Task run not found for this MCP token');
  }

  const actingUserId = taskRun.actingUserId;

  if (!hasRealTaskRunUser(actingUserId)) {
    // Deployment-service-principal jobs have no human actor. Callers that
    // support deployment-scoped connections should use
    // resolveActingUserIdOrNull instead of failing here.
    throw new McpProxyError(
      403,
      'This MCP requires a human actor on the task; the job is running as the deployment service principal',
    );
  }

  return actingUserId;
}

/**
 * Like resolveActingUserId, but returns null for deployment-service-principal
 * jobs so callers can fall back to a deployment-scoped MCP connection instead
 * of rejecting the request.
 */
export async function resolveActingUserIdOrNull(
  auth: McpAuthContext,
): Promise<string | null> {
  if (auth.tokenType !== 'run') {
    return auth.userId;
  }

  if (!auth.runId) {
    throw new McpProxyError(
      403,
      'MCP proxy requires a task run token with a task run id',
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: { actingUserId: true },
    where: eq(taskRuns.id, auth.runId),
  });

  if (!taskRun) {
    throw new McpProxyError(404, 'Task run not found for this MCP token');
  }

  return taskRun.actingUserId ?? null;
}

/**
 * Validates that the run token's run still exists. No principal equality
 * check: the run-scoped token IS the authorization (only that run's sandbox
 * holds it). The token's userId is mint-time attribution while
 * `task_runs.actingUserId` is current-steering attribution — web steer and
 * follow-up delivery mutate the acting user mid-run, so the two legitimately
 * diverge and must not be compared for authorization.
 */
async function verifyTaskRunTokenTargetExists(
  auth: RunTokenContext,
): Promise<Response | null> {
  const taskRun = await db.query.taskRuns.findFirst({
    columns: { id: true },
    where: eq(taskRuns.id, auth.runId),
  });

  if (!taskRun) {
    return jsonRpcErrorResponse(
      404,
      -32000,
      'Task run not found for this MCP token',
    );
  }

  return null;
}

export async function assertTaskRunTokenTargetExists(
  auth: RunTokenContext,
): Promise<void> {
  const validationError = await verifyTaskRunTokenTargetExists(auth);

  if (!validationError) {
    return;
  }

  let message = 'Task run token validation failed';
  try {
    const body = (await validationError.clone().json()) as {
      error?: { message?: string };
    };
    if (typeof body.error?.message === 'string' && body.error.message.length) {
      message = body.error.message;
    }
  } catch {
    // Ignore malformed JSON-RPC error bodies and fall back to the default message.
  }

  throw new McpProxyError(validationError.status, message);
}

function buildProxyRequestHeaders(
  authHeader: string | null,
  requestHeaders: Headers,
  method: string,
): Headers {
  const headers = new Headers();

  if (method === 'POST') {
    headers.set('content-type', 'application/json');
  }
  headers.set(
    'accept',
    requestHeaders.get('accept') ?? 'application/json, text/event-stream',
  );

  if (authHeader) {
    headers.set(
      'authorization',
      authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`,
    );
  }

  const sessionId = requestHeaders.get('mcp-session-id');
  if (sessionId) {
    headers.set('mcp-session-id', sessionId);
  }

  const protocolVersion = requestHeaders.get('mcp-protocol-version');
  if (protocolVersion) {
    headers.set('mcp-protocol-version', protocolVersion);
  }

  return headers;
}

export function buildProxyResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();

  const excludedHeaders = new Set([
    'connection',
    // Node fetch transparently decodes compressed upstream bodies, so forwarding
    // this header makes downstream clients try to decode the plain body again.
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);

  for (const [key, value] of upstreamHeaders.entries()) {
    if (!excludedHeaders.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  return headers;
}

function isJsonResponse(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!mediaType) {
    return false;
  }

  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

interface ResolvedCredentials {
  /** `null` for upstreams that take no Authorization header. */
  authHeader: string | null;
  extraHeaders?: Record<string, string>;
  disabledToolNames?: readonly string[] | null;
  /**
   * Per-request upstream URL. Required when the proxy was constructed without
   * a static `upstream` (custom servers resolve theirs from the database).
   */
  upstream?: string;
}

export interface McpAuthContext {
  /**
   * Token principal. `null` means the request is authenticated as the
   * deployment service principal (a task run with no human owner); it is
   * always a real user id for `auth` tokens.
   */
  userId: string | null;
  tokenType: 'run' | 'auth';
  runId?: number;
}

interface McpProxyConfig {
  name: string;
  /** Static upstream URL; omit when resolveCredentials returns one. */
  upstream?: string;
  resolveCredentials: (
    auth: McpAuthContext,
    routeParams: Record<string, string>,
  ) => Promise<ResolvedCredentials>;
  allowAuthTokens?: boolean;
  validateTaskRunToken?: (auth: RunTokenContext) => Promise<Response | null>;
  allowedToolNames?: readonly string[];
  stripToolSchemaPatterns?: boolean;
  timeoutMs?: number;
  /**
   * Enable SSRF guarding for operator-controlled upstreams: URL and DNS
   * answers are vetted (with connect pinned to the vetted addresses), and
   * upstream redirects are refused rather than followed — following one
   * would re-send the injected Authorization header to a server-chosen URL.
   */
  guardUpstreamEgress?: { allowedPrivateCidrs?: string };
  /** Reject request bodies larger than this many bytes (413). */
  maxRequestBodyBytes?: number;
}

export class McpProxyError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpProxyError';
  }
}

type JsonRpcRequestLike = {
  method?: unknown;
  params?: unknown;
};

function getJsonRpcMethod(request: unknown): string | null {
  if (!request || typeof request !== 'object' || !('method' in request)) {
    return null;
  }

  const method = (request as JsonRpcRequestLike).method;
  return typeof method === 'string' ? method : null;
}

function getToolCallName(request: unknown): string | null {
  if (
    !request ||
    typeof request !== 'object' ||
    (request as JsonRpcRequestLike).method !== 'tools/call'
  ) {
    return null;
  }

  const params = (request as JsonRpcRequestLike).params;
  if (!params || typeof params !== 'object' || !('name' in params)) {
    return null;
  }

  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function isExpectedProxyDisconnect(error: unknown): error is DOMException {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * Resend's MCP uses Zod's email schema, which serializes to a JSON Schema
 * `pattern` containing regex lookarounds. Azure OpenAI rejects `pattern` in
 * tool schemas, while Resend still validates the actual tool call upstream.
 * Strip only the model-facing keyword at this proxy boundary.
 */
function stripToolSchemaPatterns(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripToolSchemaPatterns);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'pattern')
      .map(([key, nestedValue]) => [key, stripToolSchemaPatterns(nestedValue)]),
  );
}

/**
 * Google AI Studio validates function declarations strictly: every ARRAY
 * schema must carry `items`, and the AI SDK's JSON-Schema-to-Gemini
 * conversion splits `type: ["array", "null"]` unions into `anyOf` branches
 * while leaving `items`/`properties` at the outer level, so an upstream
 * schema that is perfectly valid JSON Schema (Pylon's `tags` and
 * `custom_field_filters` search filters, for example) turns into an invalid
 * request that fails the whole task turn. Normalize the shapes that trigger
 * this at the proxy boundary: rewrite array/object type unions into explicit
 * `anyOf` branches with each branch keeping only its own type's keywords, and
 * give array schemas that declare no item shape at all a permissive string
 * `items` (the upstream server still validates the actual tool call). The
 * transform must never destroy information the upstream declared: declared
 * `items` of any form pass through untouched, and data-carrying keywords
 * (`default`, `const`, `enum`, `examples`) are never recursed into.
 */
const ARRAY_ONLY_SCHEMA_KEYWORDS = [
  'items',
  'additionalItems',
  'unevaluatedItems',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
] as const;

const OBJECT_ONLY_SCHEMA_KEYWORDS = [
  'properties',
  'required',
  'additionalProperties',
  'unevaluatedProperties',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'dependentSchemas',
] as const;

// Keywords that constrain the value in ways a per-type branch split cannot
// represent (combinators, references, conditionals). A composite union
// carrying any of these as a sibling is left untouched: splitting it would
// silently drop the constraint and widen what the schema accepts.
const UNION_SPLIT_BLOCKING_KEYWORDS = [
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  '$dynamicRef',
] as const;

const STRING_ONLY_SCHEMA_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
] as const;

const NUMERIC_ONLY_SCHEMA_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;

// Union branches keep only the structural keywords that belong to their own
// type; anything else leaking into a branch (a `minLength` on an array
// branch, a `default: null` on an object branch) produces self-contradictory
// schemas that strict providers can reject outright.
const UNION_BRANCH_KEYWORDS_BY_TYPE: Record<string, readonly string[]> = {
  array: ARRAY_ONLY_SCHEMA_KEYWORDS,
  object: OBJECT_ONLY_SCHEMA_KEYWORDS,
  string: STRING_ONLY_SCHEMA_KEYWORDS,
  number: NUMERIC_ONLY_SCHEMA_KEYWORDS,
  integer: NUMERIC_ONLY_SCHEMA_KEYWORDS,
};

// `enum` and `const` constrain the value itself and stay valid on any branch.
const UNION_BRANCH_SHARED_KEYWORDS = ['enum', 'const'] as const;

// Keys whose values are data, not schemas. Recursing into them would rewrite
// literal values that merely look like schemas (a `default` of
// `{"type": "array"}` would grow an injected `items`).
const NON_SCHEMA_VALUE_KEYWORDS = new Set([
  'default',
  'const',
  'enum',
  'examples',
]);

// Keys whose values are maps of schemas keyed by arbitrary names. Entries in
// these maps are schemas even when a property is literally named "default"
// or "enum", so the data-keyword skip above must not apply inside them.
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withProviderSafeArrayItems(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type !== 'array') {
    return schema;
  }

  // Only fill in `items` when the upstream declared nothing at all. A
  // declared shape of any form (object schema, boolean, draft-04 tuple
  // array, or an explicit empty object) is the server's contract and must
  // pass through untouched.
  return 'items' in schema ? schema : { ...schema, items: { type: 'string' } };
}

function normalizeToolSchemaForStrictProviders(
  value: unknown,
  context: 'schema' | 'schema-map' = 'schema',
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeToolSchemaForStrictProviders(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const schema = Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (context === 'schema' && NON_SCHEMA_VALUE_KEYWORDS.has(key)) {
        return [key, nestedValue];
      }
      return [
        key,
        normalizeToolSchemaForStrictProviders(
          nestedValue,
          context === 'schema' && SCHEMA_MAP_KEYWORDS.has(key)
            ? 'schema-map'
            : 'schema',
        ),
      ];
    }),
  );

  // A schema map's own keys are property names, not schema keywords; only
  // its entries (handled above) are schemas.
  if (context === 'schema-map') {
    return schema;
  }

  const typeValue = schema.type;
  if (
    !Array.isArray(typeValue) ||
    typeValue.length === 0 ||
    !typeValue.every((entry): entry is string => typeof entry === 'string')
  ) {
    return withProviderSafeArrayItems(schema);
  }

  if (typeValue.length === 1) {
    return withProviderSafeArrayItems({ ...schema, type: typeValue[0] });
  }

  // Scalar-only unions convert cleanly; only unions carrying a composite
  // type lose their keywords in the downstream Gemini conversion.
  if (!typeValue.includes('array') && !typeValue.includes('object')) {
    return schema;
  }

  if (UNION_SPLIT_BLOCKING_KEYWORDS.some((keyword) => keyword in schema)) {
    // Splitting the union would clobber the sibling constraint, so decline —
    // but say so, since strict providers may reject the untouched schema and
    // this log is the only breadcrumb when they do.
    console.warn(
      '[mcp-proxy] Left composite type union with a sibling combinator, reference, or conditional un-normalized; strict providers may reject this tool schema',
    );
    return schema;
  }

  const { type: _unionTypes, ...sharedKeywords } = schema;
  const branches = typeValue.map((branchType) => {
    if (branchType === 'null') {
      return { type: 'null' };
    }

    const branch: Record<string, unknown> = { type: branchType };
    for (const keyword of [
      ...(UNION_BRANCH_KEYWORDS_BY_TYPE[branchType] ?? []),
      ...UNION_BRANCH_SHARED_KEYWORDS,
    ]) {
      if (keyword in sharedKeywords) {
        branch[keyword] = sharedKeywords[keyword];
      }
    }
    return withProviderSafeArrayItems(branch);
  });

  const normalized: Record<string, unknown> = { anyOf: branches };
  if (typeof sharedKeywords.description === 'string') {
    normalized.description = sharedKeywords.description;
  }
  if ('default' in sharedKeywords) {
    normalized.default = sharedKeywords.default;
  }
  return normalized;
}

function normalizeToolDefinitionInputSchemas<
  T extends { name: string } & Record<string, unknown>,
>(tools: T[]): T[] {
  return tools.map((tool) => {
    const normalized: Record<string, unknown> = { ...tool };
    if ('inputSchema' in normalized) {
      normalized.inputSchema = normalizeToolSchemaForStrictProviders(
        normalized.inputSchema,
      );
    }
    return normalized as T;
  });
}

function filterToolsListPayload(
  payload: unknown,
  toolPolicy: {
    allowedToolNames?: readonly string[];
    disabledToolNames?: readonly string[] | null;
  },
  options?: {
    stripToolSchemaPatterns?: boolean;
  },
): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (
    !('result' in payload) ||
    !payload.result ||
    typeof payload.result !== 'object'
  ) {
    return payload;
  }

  const result = payload.result as { tools?: unknown };
  if (!Array.isArray(result.tools)) {
    return payload;
  }

  const namedTools = result.tools.filter(
    (toolDef): toolDef is { name: string } & Record<string, unknown> =>
      Boolean(
        toolDef &&
        typeof toolDef === 'object' &&
        'name' in toolDef &&
        typeof toolDef.name === 'string',
      ),
  );

  const filteredTools = normalizeToolDefinitionInputSchemas(
    filterMcpToolDefinitions(namedTools, toolPolicy),
  );

  return {
    ...payload,
    result: {
      ...result,
      tools: options?.stripToolSchemaPatterns
        ? stripToolSchemaPatterns(filteredTools)
        : filteredTools,
    },
  };
}

/**
 * Parse a single SSE event chunk and return the JSON-RPC response it carries
 * when that response matches the request `id` (and holds a `result`/`error`).
 * `notifications/progress` frames carry no `id` and are skipped. Returns `null`
 * when the event is not the matching response.
 */
function parseSseEventJsonRpcResponse(
  eventChunk: string,
  expectedId: JsonRpcRequestId,
  matchAnyResponse = false,
): unknown | null {
  const dataText = eventChunk
    .split(/\r?\n/)
    .flatMap((line) =>
      line.startsWith('data:') ? [line.slice('data:'.length).trimStart()] : [],
    )
    .join('\n')
    .trim();

  if (dataText.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const message = parsed as {
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  const hasResponsePayload = 'result' in message || 'error' in message;
  const idMatches =
    matchAnyResponse ||
    (expectedId === null
      ? message.id === undefined || message.id === null
      : message.id === expectedId ||
        // Tolerate upstreams that echo a numeric id as a string (or vice
        // versa); a missed match here means the reply is forwarded as the
        // raw upstream stream instead of the rebuilt, filtered payload.
        ((typeof message.id === 'string' || typeof message.id === 'number') &&
          String(message.id) === String(expectedId)));

  return hasResponsePayload && idMatches ? parsed : null;
}

/**
 * Read an SSE-framed MCP reply incrementally and resolve with the JSON-RPC
 * response whose `id` matches the request as soon as that frame arrives —
 * without waiting for the stream to close.
 *
 * Streamable HTTP MCP servers may answer a POST request with
 * `content-type: text/event-stream`, delivering the JSON-RPC response as one
 * `data:` frame (optionally preceded by `notifications/progress` frames). The
 * spec allows the server to keep that SSE connection open after the response
 * to emit further messages, so waiting for closure could hang the caller. This
 * returns the matching response frame the moment it is seen and cancels the
 * reader. Returns `null` if the stream ends before a matching response frame
 * appears.
 *
 * `matchAnyResponse` accepts the first frame carrying a `result`/`error`
 * regardless of its id — used for id-less requests whose reply must still be
 * rebuilt (a restricted connection's tools/list). `timeoutMs` bounds the
 * whole read and throws on expiry so a never-closing stream cannot hang the
 * caller.
 */
async function readMatchingSseJsonRpcResponse(
  body: ReadableStream<Uint8Array>,
  expectedId: JsonRpcRequestId,
  options?: { matchAnyResponse?: boolean; timeoutMs?: number },
): Promise<unknown | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const matchAnyResponse = options?.matchAnyResponse ?? false;
  const deadline =
    options?.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;

  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (deadline === null) {
      return reader.read();
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out reading upstream SSE response');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out reading upstream SSE response'));
          }, remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    for (;;) {
      const { done, value } = await readNext();

      if (value) {
        buffer += decoder.decode(value, { stream: true });

        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary) {
            break;
          }

          const eventChunk = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);

          const match = parseSseEventJsonRpcResponse(
            eventChunk,
            expectedId,
            matchAnyResponse,
          );
          if (match !== null) {
            return match;
          }
        }
      }

      if (done) {
        buffer += decoder.decode();
        return parseSseEventJsonRpcResponse(
          buffer,
          expectedId,
          matchAnyResponse,
        );
      }
    }
  } finally {
    // Fire-and-forget: awaiting cancel() on a teed branch can block until the
    // other branch drains, which would defeat the early return.
    reader.cancel().catch(() => {
      // Ignore cancel failures on an already-settled reader.
    });
  }
}

// How long a restricted connection's tools/list rebuild will wait for an
// uncorrelatable SSE reply before giving up. Generous relative to a normal
// tools/list round trip, but bounded so a server that never closes its
// response channel cannot hang the proxy.
const UNCORRELATED_SSE_TOOLS_LIST_TIMEOUT_MS = 10_000;

class RequestBodyTooLargeError extends Error {
  constructor(readonly observedBytes: number) {
    super('Request body exceeds the configured limit');
    this.name = 'RequestBodyTooLargeError';
  }
}

/**
 * Read a request body as text without ever buffering more than `maxBytes`.
 *
 * `Content-Length` is checked first so an oversized request is rejected
 * before a single chunk is read, but it is only a hint: chunked bodies omit
 * it and a hostile client can understate it. The streamed read is therefore
 * the real bound — it aborts as soon as the accumulated size crosses the
 * limit, so an unbounded body can never be materialized (nor re-serialized)
 * in memory.
 */
async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(declaredLength);
  }

  const body = request.body;

  if (!body) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(total);
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

export function createMcpProxy(config: McpProxyConfig) {
  const {
    name,
    upstream,
    resolveCredentials,
    timeoutMs = 30_000,
    allowAuthTokens = false,
    validateTaskRunToken = verifyTaskRunTokenTargetExists,
    allowedToolNames,
    stripToolSchemaPatterns: shouldStripToolSchemaPatterns = false,
    guardUpstreamEgress,
    maxRequestBodyBytes,
  } = config;

  // Guarded dispatchers pin connections to DNS answers vetted against the
  // private-range blocklist; constructed once per proxy, shared by requests.
  const guardedLongLivedDispatcher = guardUpstreamEgress
    ? new Agent({
        bodyTimeout: 0,
        connect: createGuardedConnectOptions({
          allowedPrivateCidrs: guardUpstreamEgress.allowedPrivateCidrs,
        }),
      })
    : null;
  const guardedDefaultDispatcher = guardUpstreamEgress
    ? new Agent({
        connect: createGuardedConnectOptions({
          allowedPrivateCidrs: guardUpstreamEgress.allowedPrivateCidrs,
        }),
      })
    : null;

  const app = new Hono<{ Variables: Variables }>();

  app.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
    const startedAt = Date.now();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const requestId = crypto.randomUUID();
    const logPrefix = `[MCP Proxy:${name}]`;
    const rawAuth = c.get('authContext');

    if (!rawAuth) {
      console.warn(
        formatSingleLineLog(`${logPrefix} Missing auth context`, {
          requestId,
          method,
          path,
        }),
      );
      return jsonRpcErrorResponse(
        401,
        -32001,
        'Unauthorized: missing or invalid bearer token',
      );
    }

    let auth: McpAuthContext;

    if (isRunTokenContext(rawAuth)) {
      const taskRunValidationError = await validateTaskRunToken(rawAuth);
      if (taskRunValidationError) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Task run auth validation failed`, {
            requestId,
            method,
            path,
            tokenType: rawAuth.tokenType,
            runId: rawAuth.runId,
            userId: rawAuth.userId,
            status: taskRunValidationError.status,
          }),
        );
        return taskRunValidationError;
      }

      auth = {
        userId: rawAuth.userId,
        tokenType: 'run',
        runId: rawAuth.runId,
      };
    } else if (allowAuthTokens && isUserToken(rawAuth)) {
      auth = {
        userId: rawAuth.userId,
        tokenType: 'auth',
      };
    } else {
      console.warn(
        formatSingleLineLog(
          `${logPrefix} Unsupported token type for endpoint`,
          {
            requestId,
            method,
            path,
            allowAuthTokens,
          },
        ),
      );
      return jsonRpcErrorResponse(
        403,
        -32000,
        allowAuthTokens
          ? `${name} MCP requires a user-scoped auth token or task run token`
          : `${name} MCP is only available for task run tokens`,
      );
    }

    let upstreamBody: string | undefined;
    let parsedBody: unknown;

    if (method === 'POST') {
      try {
        if (maxRequestBodyBytes === undefined) {
          parsedBody = await c.req.json();
          upstreamBody = JSON.stringify(parsedBody);
        } else {
          // Capped upstreams (custom servers) must be bounded *before* the
          // body is buffered or parsed, so forward the vetted text as-is
          // rather than re-serializing it.
          upstreamBody = await readBoundedRequestText(
            c.req.raw,
            maxRequestBodyBytes,
          );
          parsedBody = JSON.parse(upstreamBody);
        }
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          console.warn(
            formatSingleLineLog(`${logPrefix} Request body too large`, {
              requestId,
              method,
              path,
              tokenType: auth.tokenType,
              userId: auth.userId,
              bytes: error.observedBytes,
              limit: maxRequestBodyBytes,
            }),
          );
          return jsonRpcErrorResponse(
            413,
            -32600,
            `${name} MCP request body exceeds the size limit`,
          );
        }

        console.warn(
          formatSingleLineLog(`${logPrefix} Invalid JSON request body`, {
            requestId,
            method,
            path,
            tokenType: auth.tokenType,
            userId: auth.userId,
          }),
        );
        return jsonRpcErrorResponse(400, -32700, 'Invalid JSON body');
      }
    }

    let credentials: ResolvedCredentials;

    try {
      credentials = await resolveCredentials(auth, c.req.param());
    } catch (error) {
      console.warn(
        formatSingleLineLog(`${logPrefix} Failed to resolve credentials`, {
          requestId,
          method,
          path,
          tokenType: auth.tokenType,
          userId: auth.userId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (error instanceof McpProxyError) {
        return jsonRpcErrorResponse(error.httpStatus, -32000, error.message);
      }
      return jsonRpcErrorResponse(
        500,
        -32603,
        `Failed to resolve ${name} credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const effectiveUpstream = credentials.upstream ?? upstream;

    if (!effectiveUpstream) {
      console.error(
        formatSingleLineLog(`${logPrefix} No upstream URL resolved`, {
          requestId,
          method,
          path,
        }),
      );
      return jsonRpcErrorResponse(
        500,
        -32603,
        `${name} MCP has no upstream URL configured`,
      );
    }

    try {
      const effectiveAllowedToolNames = getEffectiveAllowedMcpToolNames({
        allowedToolNames,
        disabledToolNames: credentials.disabledToolNames,
      });
      const hasToolRestrictions = Boolean(
        effectiveAllowedToolNames || credentials.disabledToolNames?.length,
      );

      if (
        hasToolRestrictions &&
        method === 'POST' &&
        Array.isArray(parsedBody)
      ) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Rejected batch JSON-RPC request`, {
            requestId,
            method,
            path,
            tokenType: auth.tokenType,
            userId: auth.userId,
          }),
        );
        return jsonRpcErrorResponse(
          400,
          -32600,
          `${name} MCP batch JSON-RPC requests are not allowed on this endpoint`,
        );
      }

      if (hasToolRestrictions && method === 'POST') {
        const toolName = getToolCallName(parsedBody);
        if (
          toolName &&
          !isMcpToolAllowed(toolName, {
            allowedToolNames,
            disabledToolNames: credentials.disabledToolNames,
          })
        ) {
          console.warn(
            formatSingleLineLog(
              `${logPrefix} Rejected disallowed MCP tool call`,
              {
                requestId,
                method,
                path,
                tokenType: auth.tokenType,
                userId: auth.userId,
                toolName,
              },
            ),
          );
          return jsonRpcErrorResponse(
            403,
            -32000,
            `${name} MCP tool "${toolName}" is not allowed on this endpoint`,
            getJsonRpcRequestId(parsedBody),
          );
        }
      }

      const proxyHeaders = buildProxyRequestHeaders(
        credentials.authHeader,
        c.req.raw.headers,
        method,
      );

      if (credentials.extraHeaders) {
        for (const [key, value] of Object.entries(credentials.extraHeaders)) {
          proxyHeaders.set(key, value);
        }
      }

      const isLongLivedStreamableTransportRequest =
        method === 'GET' || method === 'POST';

      const signal = isLongLivedStreamableTransportRequest
        ? c.req.raw.signal
        : AbortSignal.any([
            AbortSignal.timeout(timeoutMs),
            ...(c.req.raw.signal ? [c.req.raw.signal] : []),
          ]);

      const upstreamRequestInit = {
        method,
        headers: proxyHeaders,
        body: upstreamBody,
        signal,
        // Operator-controlled upstreams must not have their redirects
        // followed: a 302 would re-send the injected Authorization header to
        // a server-chosen URL, bypassing the egress guard.
        ...(guardUpstreamEgress ? { redirect: 'manual' as const } : {}),
      };

      let upstreamResponse: Response;

      if (guardUpstreamEgress) {
        assertEgressUrlAllowed(
          effectiveUpstream,
          guardUpstreamEgress.allowedPrivateCidrs,
        );

        upstreamResponse = await fetch(effectiveUpstream, {
          ...upstreamRequestInit,
          dispatcher: isLongLivedStreamableTransportRequest
            ? guardedLongLivedDispatcher!
            : guardedDefaultDispatcher!,
        } as RequestInit);

        if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
          console.warn(
            formatSingleLineLog(`${logPrefix} Refused upstream redirect`, {
              requestId,
              method,
              path,
              upstream: effectiveUpstream,
              status: upstreamResponse.status,
            }),
          );
          return jsonRpcErrorResponse(
            502,
            -32000,
            `${name} MCP upstream answered with a redirect, which is not followed for custom servers`,
          );
        }
      } else {
        upstreamResponse = isLongLivedStreamableTransportRequest
          ? await fetchWithLongLivedStreamDispatcher(
              effectiveUpstream,
              upstreamRequestInit,
            )
          : await fetch(effectiveUpstream, upstreamRequestInit);
      }

      const elapsedMs = Date.now() - startedAt;
      const contentType = upstreamResponse.headers.get('content-type');
      const isSseResponse =
        contentType?.toLowerCase().includes('text/event-stream') ?? false;
      const jsonRpcRequestId = getJsonRpcRequestId(parsedBody);
      const canReadMatchingSseResponse =
        isSseResponse &&
        jsonRpcRequestId !== null &&
        !Array.isArray(parsedBody);

      if (!upstreamResponse.ok) {
        console.warn(
          formatSingleLineLog(`${logPrefix} Upstream returned non-OK status`, {
            requestId,
            method,
            path,
            upstream: effectiveUpstream,
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            contentType,
            elapsedMs,
          }),
        );
      }

      // Every tools/list reply is rebuilt (not just restricted ones) so tool
      // schemas can be normalized for strict model providers. Connections
      // with tool restrictions or schema stripping must never see an
      // unfiltered tools/list, even when the upstream reply is an SSE stream
      // we cannot correlate.
      const mustFilterToolsList =
        hasToolRestrictions || shouldStripToolSchemaPatterns;

      if (
        method === 'POST' &&
        getJsonRpcMethod(parsedBody) === 'tools/list' &&
        upstreamResponse.ok &&
        // An SSE response without a correlatable JSON-RPC id may remain open
        // indefinitely. Preserve that stream for unrestricted connections;
        // restricted connections fall back to a bounded buffered read.
        (!isSseResponse || canReadMatchingSseResponse || mustFilterToolsList)
      ) {
        try {
          const sseBody = isSseResponse ? upstreamResponse.clone().body : null;
          const payload = sseBody
            ? await readMatchingSseJsonRpcResponse(
                sseBody,
                canReadMatchingSseResponse ? jsonRpcRequestId : null,
                canReadMatchingSseResponse
                  ? undefined
                  : // An id-less request can't be correlated; accept the
                    // first response frame within a bounded window so the
                    // restricted rebuild neither hangs nor mistakes a
                    // progress notification for the reply.
                    {
                      matchAnyResponse: true,
                      timeoutMs: UNCORRELATED_SSE_TOOLS_LIST_TIMEOUT_MS,
                    },
              )
            : parseMcpJsonRpcPayload(
                await upstreamResponse.clone().text(),
                contentType,
              );
          if (!payload) {
            throw new Error('Unable to parse upstream tools/list payload');
          }
          const filteredPayload = filterToolsListPayload(
            payload,
            {
              allowedToolNames: effectiveAllowedToolNames,
              disabledToolNames: credentials.disabledToolNames,
            },
            {
              stripToolSchemaPatterns: shouldStripToolSchemaPatterns,
            },
          );
          const headers = buildProxyResponseHeaders(upstreamResponse.headers);
          headers.set('content-type', 'application/json');

          // The raw upstream tee branch is no longer needed on any rebuild
          // path; cancel it so the buffered body is released promptly.
          upstreamResponse.body?.cancel().catch(() => {});

          return new Response(JSON.stringify(filteredPayload), {
            status: upstreamResponse.status,
            headers,
          });
        } catch (error) {
          if (mustFilterToolsList) {
            console.warn(
              formatSingleLineLog(
                `${logPrefix} Refusing to forward a tools/list reply that could not be filtered`,
                {
                  requestId,
                  method,
                  path,
                  upstream: effectiveUpstream,
                  tokenType: auth.tokenType,
                  userId: auth.userId,
                  error: error instanceof Error ? error.message : String(error),
                },
              ),
            );
            return jsonRpcErrorResponse(
              502,
              -32000,
              `${name} MCP upstream returned a tools/list reply that could not be filtered for this connection`,
              jsonRpcRequestId,
            );
          }
          // Fall through to the raw upstream response if the body is not JSON.
        }
      }

      if (method === 'POST' && isJsonResponse(contentType)) {
        return new Response(await upstreamResponse.text(), {
          status: upstreamResponse.status,
          headers: buildProxyResponseHeaders(upstreamResponse.headers),
        });
      }

      // Some Streamable HTTP MCP servers (e.g. X) answer a POST request with an
      // SSE stream that carries the single JSON-RPC response as one `data:`
      // frame. Not every MCP client consumes an SSE-framed reply to a POST —
      // OpenCode, for one, hangs until its request timeout and cancels the call
      // even though the upstream already returned the result in milliseconds.
      // Normalize such single-response SSE replies to a plain JSON body (the
      // same shape tools/list replies are re-serialized into above) so every
      // client can read them. The reply is read incrementally and returned the
      // moment the id-matched response frame arrives, so a server that keeps
      // the SSE connection open after responding does not stall the proxy.
      // Requests without an id are notifications with no response, and streams
      // that end without a matching response fall through to the raw stream.
      const sseResponseBody =
        method === 'POST' && upstreamResponse.ok && canReadMatchingSseResponse
          ? upstreamResponse.clone().body
          : null;

      if (sseResponseBody) {
        try {
          const response = await readMatchingSseJsonRpcResponse(
            sseResponseBody,
            jsonRpcRequestId,
          );
          if (response) {
            // The raw upstream body is no longer needed; cancel it to release
            // the upstream connection instead of leaving it open.
            upstreamResponse.body?.cancel().catch(() => {});

            const headers = buildProxyResponseHeaders(upstreamResponse.headers);
            headers.set('content-type', 'application/json');

            return new Response(JSON.stringify(response), {
              status: upstreamResponse.status,
              headers,
            });
          }
        } catch {
          // Fall through to streaming the raw upstream response.
        }
      }

      return new Response(
        createLoggedProxyResponseBody({
          body: upstreamResponse.body,
          logPrefix: `${logPrefix} Upstream response stream failed`,
          getLogFields: () => ({
            requestId,
            method,
            path,
            upstream: effectiveUpstream,
            status: upstreamResponse.status,
            tokenType: auth.tokenType,
            userId: auth.userId ?? undefined,
            elapsedMs: Date.now() - startedAt,
          }),
          trackingContext: {
            route: `mcp:${name}`,
            method,
            path,
            requestId,
          },
        }),
        {
          status: upstreamResponse.status,
          headers: buildProxyResponseHeaders(upstreamResponse.headers),
        },
      );
    } catch (error) {
      const logDetails = {
        requestId,
        method,
        path,
        upstream: effectiveUpstream,
        tokenType: auth.tokenType,
        userId: auth.userId,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      if (isExpectedProxyDisconnect(error)) {
        console.debug(`${logPrefix} Upstream fetch failed`, logDetails);
      } else {
        console.error(`${logPrefix} Upstream fetch failed`, logDetails);
      }
      return jsonRpcErrorResponse(
        502,
        -32603,
        `Failed to proxy ${name} MCP request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  app.all('/', () => {
    return jsonRpcErrorResponse(405, -32000, 'Method not allowed');
  });

  return app;
}
