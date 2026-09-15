import { NextResponse } from 'next/server';

import {
  createIntegration,
  listIntegrations,
  revokeIntegration,
} from '@roomote/sdk/server/session-secrets';
import {
  integrationCreateSchema,
  sessionSecretRevokeSchema,
} from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { readBoundedJsonBody } from '@/lib/server/bounded-json-body';
import { Env } from '@/lib/server/env';

/**
 * The signed-in user's integrations (owner-scoped Session secrets): metadata
 * only, never a credential. Listing needs only the server identity; adding
 * and revoking require a same-origin JSON body, like the Session route.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const maxBodyBytes = 20 * 1024;

function error(status: number) {
  return NextResponse.json(
    { error: 'Request unavailable' },
    { status, headers },
  );
}

async function sameOriginJson(request: Request) {
  // Only configured public authority is trusted, never caller-supplied proxy headers.
  const ownUrl = new URL(Env.R_PUBLIC_URL ?? Env.R_APP_URL);
  if (
    !['http:', 'https:'].includes(ownUrl.protocol) ||
    request.headers.get('origin') !== ownUrl.origin
  ) {
    return { ok: false as const, status: 403 as const };
  }
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    return { ok: false as const, status: 415 as const };
  }
  return readBoundedJsonBody(request, {
    maxBytes: maxBodyBytes,
    timeoutMs: 10_000,
  });
}

export async function GET() {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    return NextResponse.json(
      { secrets: await listIntegrations(auth.userId) },
      { headers },
    );
  } catch {
    return error(500);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    const body = await sameOriginJson(request);
    if (!body.ok) return error(body.status);
    const args = integrationCreateSchema.safeParse(body.value);
    if (!args.success) return error(400);
    const secret = await createIntegration(auth.userId, args.data);
    return NextResponse.json({ secret }, { status: 201, headers });
  } catch {
    // Never log request values, validation details, or upstream exception messages.
    return error(500);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    const body = await sameOriginJson(request);
    if (!body.ok) return error(body.status);
    const args = sessionSecretRevokeSchema.safeParse(body.value);
    if (!args.success) return error(400);
    await revokeIntegration(auth.userId, args.data);
    return new NextResponse(null, { status: 204, headers });
  } catch {
    return error(500);
  }
}
