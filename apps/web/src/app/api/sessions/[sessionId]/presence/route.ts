import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  disconnectSessionPresence,
  listSessionPresentUserIds,
  refreshSessionPresence,
} from '@roomote/redis';

import { authorize } from '@/lib/server/auth-context';
import {
  findAccessibleSession,
  findReadableSession,
} from '@/lib/server/sessions';
import { getUsersById } from '@/lib/server/users';

export const runtime = 'nodejs';

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const bodySchema = z.object({ clientId: z.string().uuid() });

async function authorizePresenceRequest(
  props: {
    params: Promise<{ sessionId: string }>;
  },
  readOnly = false,
) {
  const auth = await authorize();
  if (!auth.success) {
    return {
      success: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const params = paramsSchema.safeParse(await props.params);
  if (!params.success) {
    return {
      success: false as const,
      response: NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 },
      ),
    };
  }

  const session = await (
    readOnly ? findReadableSession : findAccessibleSession
  )(auth, params.data.sessionId);
  if (!session) {
    return {
      success: false as const,
      response: NextResponse.json({ error: 'Not Found' }, { status: 404 }),
    };
  }

  return {
    success: true as const,
    auth,
    sessionId: session.id,
  };
}

export async function GET(
  _request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const context = await authorizePresenceRequest(props, true);
  if (!context.success) return context.response;

  const userIds = await listSessionPresentUserIds(context.sessionId);
  const viewers = await getUsersById(userIds);
  return NextResponse.json(Object.values(viewers), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const context = await authorizePresenceRequest(props);
  if (!context.success) return context.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const lease = await refreshSessionPresence({
    sessionId: context.sessionId,
    userId: context.auth.userId,
    clientId: body.data.clientId,
  });
  return NextResponse.json(lease);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const context = await authorizePresenceRequest(props);
  if (!context.success) return context.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  await disconnectSessionPresence({
    sessionId: context.sessionId,
    userId: context.auth.userId,
    clientId: body.data.clientId,
  });
  return new NextResponse(null, { status: 204 });
}
