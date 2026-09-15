import { NextResponse } from 'next/server';

import {
  listAccountSecrets,
  revokeAccountSecret,
} from '@roomote/sdk/server/session-secrets';
import { sessionSecretRevokeSchema } from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { readBoundedJsonBody } from '@/lib/server/bounded-json-body';
import { Env } from '@/lib/server/env';

/**
 * The signed-in user's saved integrations (account-scoped Session secrets):
 * metadata only, never a credential. Listing needs only the server identity;
 * revocation additionally requires a same-origin JSON body, like the Session
 * secrets route.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

function error(status: number) {
  return NextResponse.json(
    { error: 'Request unavailable' },
    { status, headers },
  );
}

export async function GET() {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    return NextResponse.json(
      { secrets: await listAccountSecrets(auth.userId) },
      { headers },
    );
  } catch {
    return error(500);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    // Only configured public authority is trusted, never caller-supplied proxy headers.
    const ownUrl = new URL(Env.R_PUBLIC_URL ?? Env.R_APP_URL);
    if (
      !['http:', 'https:'].includes(ownUrl.protocol) ||
      request.headers.get('origin') !== ownUrl.origin
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
      maxBytes: 4 * 1024,
      timeoutMs: 10_000,
    });
    if (!body.ok) return error(body.status);
    const args = sessionSecretRevokeSchema.safeParse(body.value);
    if (!args.success) return error(400);
    await revokeAccountSecret(auth.userId, args.data);
    return new NextResponse(null, { status: 204, headers });
  } catch {
    // Never log request values, validation details, or upstream exception messages.
    return error(500);
  }
}
