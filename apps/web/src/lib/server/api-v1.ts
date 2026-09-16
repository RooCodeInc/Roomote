import { NextResponse, type NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z, type ZodTypeAny } from 'zod';

import { db, eq, sessions as unifiedSessions } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { authorize } from './auth-context';
import { readBoundedJsonBody } from './bounded-json-body';

/**
 * Shared plumbing for the versioned JSON API under `/api/v1`.
 *
 * The API is the native-client (iOS) contract documented in
 * `apps/ios/docs/api-v1.md`. Handlers call the same command functions the
 * web tRPC routers call and serialize their results as plain JSON, so the
 * two surfaces cannot drift in behavior. Auth is the regular web session,
 * carried either as a cookie or as `Authorization: Bearer` through the
 * better-auth bearer plugin.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = 15_000;

export class ApiV1Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiV1Error';
  }
}

export function jsonOk(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { status: init?.status ?? 200 });
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const TRPC_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
};

function toErrorResponse(error: unknown) {
  if (error instanceof ApiV1Error) {
    return jsonError(error.message, error.status);
  }
  if (error instanceof TRPCError) {
    return jsonError(error.message, TRPC_STATUS[error.code] ?? 500);
  }
  if (error instanceof z.ZodError) {
    return jsonError(error.issues[0]?.message ?? 'Invalid request', 400);
  }
  // Commands raise plain Errors for missing rows ("… not found"); the API
  // maps those to 404 so the client can drop stale references.
  if (error instanceof Error && /not found/i.test(error.message)) {
    return jsonError(error.message, 404);
  }
  console.error('[api/v1] Unhandled error:', error);
  return jsonError('Internal server error', 500);
}

type RouteContext<P> = { params: Promise<P> };

type ApiV1Handler<P> = (input: {
  request: NextRequest;
  auth: UserAuthSuccess;
  params: P;
}) => Promise<Response>;

/**
 * Wrap a route handler with session auth and uniform error mapping.
 */
export function withApiV1Auth<P = Record<string, never>>(
  handler: ApiV1Handler<P>,
) {
  return async (
    request: NextRequest,
    context?: RouteContext<P>,
  ): Promise<Response> => {
    try {
      const auth = await authorize();
      if (!auth.success) {
        return jsonError(auth.error, 401);
      }
      const params = (await context?.params) ?? ({} as P);
      return await handler({ request, auth, params });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function readJsonBody<S extends ZodTypeAny>(
  request: NextRequest,
  schema: S,
): Promise<z.infer<S>> {
  const body = await readBoundedJsonBody(request, {
    maxBytes: MAX_BODY_BYTES,
    timeoutMs: BODY_TIMEOUT_MS,
  });
  if (!body.ok) {
    throw new ApiV1Error(
      body.status === 413
        ? 'Request body too large'
        : body.status === 408
          ? 'Request body timed out'
          : 'Invalid JSON body',
      body.status,
    );
  }
  return schema.parse(body.value);
}

export function readSearchParams<S extends ZodTypeAny>(
  request: NextRequest,
  schema: S,
): z.infer<S> {
  return schema.parse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
}

/**
 * Session routes accept either the unified session id or the Fast
 * conversation id, because the app navigates by the former (list rows,
 * deep links) but streams by the latter (existing SSE route). Resolve both.
 */
export async function resolveSessionIds(id: string): Promise<{
  sessionId: string | null;
  fastConversationId: string;
}> {
  if (!z.string().uuid().safeParse(id).success) {
    throw new ApiV1Error('Session not found', 404);
  }
  const [byId] = await db
    .select({
      id: unifiedSessions.id,
      fastConversationId: unifiedSessions.fastConversationId,
    })
    .from(unifiedSessions)
    .where(eq(unifiedSessions.id, id))
    .limit(1);
  if (byId) {
    if (!byId.fastConversationId) {
      throw new ApiV1Error('Session has no conversation', 409);
    }
    return { sessionId: byId.id, fastConversationId: byId.fastConversationId };
  }
  const [byConversation] = await db
    .select({ id: unifiedSessions.id })
    .from(unifiedSessions)
    .where(eq(unifiedSessions.fastConversationId, id))
    .limit(1);
  return { sessionId: byConversation?.id ?? null, fastConversationId: id };
}

export const dataUrlImageSchema = z
  .string()
  .max(6 * 1024 * 1024)
  .regex(/^data:image\/[a-z0-9.+-]+;base64,/i, 'Images must be data URLs');
