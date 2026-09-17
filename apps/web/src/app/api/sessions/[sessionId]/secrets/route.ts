import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  db,
  eq,
  isDeploymentExperimentEnabled,
  sessions,
} from '@roomote/db/server';
import { replyToFastSessionCommand } from '@/trpc/commands/fast-sessions';

import {
  createServiceCredential,
  listServiceCredentialApprovals,
  revokeServiceCredential,
} from '@roomote/sdk/server/service-credentials';
import {
  serviceCredentialCreateSchema,
  serviceCredentialRevokeSchema,
} from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { readBoundedJsonBody } from '@/lib/server/bounded-json-body';
import { buildIntegrationSavedContinuation } from '@/lib/server/integration-saved-continuation';
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
      return NextResponse.json(await listServiceCredentialApprovals(context), {
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

    const body = await readBoundedJsonBody(request, {
      maxBytes: maxBodyBytes,
      timeoutMs: 10_000,
    });
    if (!body.ok) return error(body.status);
    const rawArgs = body.value;
    if (method === 'POST') {
      const args = serviceCredentialCreateSchema.safeParse(rawArgs);
      if (!args.success) return error(400);
      const secret = await createServiceCredential(context, args.data);
      let resumed = false;
      try {
        const [session, serviceCredentialToolsEnabled] = await Promise.all([
          db.query.sessions.findFirst({
            where: eq(sessions.id, context.sessionId),
            columns: {
              fastConversationId: true,
              ownerKind: true,
              ownerUserId: true,
              archivedAt: true,
            },
          }),
          isDeploymentExperimentEnabled('serviceCredentialTools'),
        ]);
        if (
          session?.fastConversationId &&
          session.ownerKind === 'user' &&
          session.ownerUserId === auth.userId &&
          !session.archivedAt
        ) {
          await replyToFastSessionCommand(auth, {
            sessionId: session.fastConversationId,
            text: buildIntegrationSavedContinuation(
              serviceCredentialToolsEnabled,
            ),
          });
          resumed = true;
        }
      } catch {
        // Saving succeeded. Never retry secret insertion to retry a continuation.
      }
      return NextResponse.json({ secret, resumed }, { status: 201, headers });
    }
    const args = serviceCredentialRevokeSchema.safeParse(rawArgs);
    if (!args.success) return error(400);
    await revokeServiceCredential(context, args.data);
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
