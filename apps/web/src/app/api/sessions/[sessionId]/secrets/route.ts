import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, eq, sessions } from '@roomote/db/server';
import { replyToFastSessionCommand } from '@/trpc/commands/fast-sessions';

import {
  createSessionSecret,
  listSessionSecretApprovals,
  revokeSessionSecret,
} from '@roomote/sdk/server/session-secrets';
import {
  sessionSecretCreateSchema,
  sessionSecretRevokeSchema,
} from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { Env } from '@/lib/server/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const maxBodyBytes = 20 * 1024;
type Props = { params: Promise<{ sessionId: string }> };

function error(status: number) {
  return NextResponse.json(
    { error: 'Request unavailable' },
    { status, headers },
  );
}

async function handle(
  request: Request,
  props: Props,
  method: 'GET' | 'POST' | 'DELETE',
) {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    const params = z
      .object({ sessionId: z.string().uuid() })
      .safeParse(await props.params);
    if (!params.success) return error(400);
    const context = { sessionId: params.data.sessionId, userId: auth.userId };

    if (method === 'GET') {
      return NextResponse.json(await listSessionSecretApprovals(context), {
        headers,
      });
    }

    // Only configured public authority is trusted, never caller-supplied proxy headers.
    const ownUrl = new URL(Env.R_PUBLIC_URL ?? Env.R_APP_URL);
    const origin = request.headers.get('origin');
    if (
      !['http:', 'https:'].includes(ownUrl.protocol) ||
      origin !== ownUrl.origin
    ) {
      return error(403);
    }
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    ) {
      return error(415);
    }

    const reader = request.body?.getReader();
    if (!reader) return error(400);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '';
    let bytes = 0;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Request unavailable'));
        void reader.cancel().catch(() => {});
      }, 10_000);
    });
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBodyBytes) {
          void reader.cancel().catch(() => {});
          return error(413);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch {
      return error(timedOut ? 408 : 400);
    } finally {
      clearTimeout(timer!);
      reader.releaseLock();
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(body);
    } catch {
      return error(400);
    }
    if (method === 'POST') {
      const args = sessionSecretCreateSchema.safeParse(rawArgs);
      if (!args.success) return error(400);
      const secret = await createSessionSecret(context, args.data);
      let resumed = false;
      try {
        const session = await db.query.sessions.findFirst({
          where: eq(sessions.id, context.sessionId),
          columns: {
            fastConversationId: true,
            ownerKind: true,
            ownerUserId: true,
            archivedAt: true,
          },
        });
        if (
          session?.fastConversationId &&
          session.ownerKind === 'user' &&
          session.ownerUserId === auth.userId &&
          !session.archivedAt
        ) {
          await replyToFastSessionCommand(auth, {
            sessionId: session.fastConversationId,
            text: 'I saved an API key approval securely for this Session. Check list_session_secrets or the HTTP broker list_integrations for ready approvals and continue the requested GET or HEAD request through the broker. Attached coding runs may use this same approval. Ask for the request path if it is not already specified. Never ask me to paste credentials into chat.',
          });
          resumed = true;
        }
      } catch {
        // Saving succeeded. Never retry secret insertion to retry a continuation.
      }
      return NextResponse.json({ secret, resumed }, { status: 201, headers });
    }
    const args = sessionSecretRevokeSchema.safeParse(rawArgs);
    if (!args.success) return error(400);
    await revokeSessionSecret(context, args.data);
    return new NextResponse(null, { status: 204, headers });
  } catch {
    // Never log request values, validation details, or upstream exception messages.
    return error(500);
  }
}

export async function GET(request: Request, props: Props) {
  return handle(request, props, 'GET');
}

export async function POST(request: Request, props: Props) {
  return handle(request, props, 'POST');
}

export async function DELETE(request: Request, props: Props) {
  return handle(request, props, 'DELETE');
}
