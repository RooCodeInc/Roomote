import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  disconnectSessionPresence,
  refreshSessionPresence,
} from '@roomote/redis';

import { authorize } from '@/lib/server/auth-context';
import { findAccessibleSession } from '@/lib/server/sessions';

export const runtime = 'nodejs';

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const bodySchema = z.object({ clientId: z.string().uuid() });

async function authorizePresenceRequest(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const auth = await authorize();
  if (!auth.success) {
    return {
      success: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const params = paramsSchema.safeParse(await props.params);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!params.success || !body.success) {
    return {
      success: false as const,
      response: NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      ),
    };
  }

  const session = await findAccessibleSession(auth, params.data.sessionId);
  if (!session) {
    return {
      success: false as const,
      response: NextResponse.json({ error: 'Not Found' }, { status: 404 }),
    };
  }

  return {
    success: true as const,
    auth,
    clientId: body.data.clientId,
    sessionId: session.id,
  };
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const context = await authorizePresenceRequest(request, props);
  if (!context.success) return context.response;

  const lease = await refreshSessionPresence({
    sessionId: context.sessionId,
    userId: context.auth.userId,
    clientId: context.clientId,
  });
  return NextResponse.json(lease);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const context = await authorizePresenceRequest(request, props);
  if (!context.success) return context.response;

  await disconnectSessionPresence({
    sessionId: context.sessionId,
    userId: context.auth.userId,
    clientId: context.clientId,
  });
  return new NextResponse(null, { status: 204 });
}
