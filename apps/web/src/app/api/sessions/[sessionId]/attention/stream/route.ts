import { type NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import { isDeploymentExperimentEnabled } from '@roomote/db/server';
import {
  disconnectSessionBrowserAttentionLease,
  refreshSessionBrowserAttentionLease,
} from '@roomote/redis';
import { listSessionBrowserAttentionEvents } from '@roomote/sdk/server';

import { authorize } from '@/lib/server/auth-context';
import { findAccessibleSession } from '@/lib/server/sessions';

export const runtime = 'nodejs';

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const querySchema = z.object({
  clientId: z.string().uuid(),
  permission: z.enum(['granted', 'default', 'denied', 'unsupported']),
});
const POLL_INTERVAL_MS = 1_000;
const LEASE_REFRESH_MS = 10_000;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ sessionId: string }> },
) {
  const auth = await authorize();
  if (!auth.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isDeploymentExperimentEnabled('browserNotifications'))) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  const params = paramsSchema.safeParse(await props.params);
  const query = querySchema.safeParse({
    clientId: request.nextUrl.searchParams.get('clientId'),
    permission: request.nextUrl.searchParams.get('permission'),
  });
  if (!params.success || !query.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const session = await findAccessibleSession(auth, params.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const lease = {
    sessionId: session.id,
    userId: auth.userId,
    clientId: query.data.clientId,
  };
  const since = new Date();

  return createResponse(request, async (stream) => {
    let lastLeaseRefresh = 0;
    const sent = new Set<string>();
    try {
      while (stream.isConnected) {
        const now = Date.now();
        if (now - lastLeaseRefresh >= LEASE_REFRESH_MS) {
          await refreshSessionBrowserAttentionLease({
            ...lease,
            permission: query.data.permission,
          });
          lastLeaseRefresh = now;
        }
        const events = await listSessionBrowserAttentionEvents({
          sessionId: session.id,
          userId: auth.userId,
          since,
        });
        for (const event of events) {
          const key = `${event.notificationId}:${event.mode}`;
          if (sent.has(key)) continue;
          sent.add(key);
          await stream.push(event, 'attention');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } finally {
      await disconnectSessionBrowserAttentionLease(lease).catch(
        () => undefined,
      );
    }
  });
}
