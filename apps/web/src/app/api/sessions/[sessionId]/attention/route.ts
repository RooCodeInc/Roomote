import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isDeploymentExperimentEnabled } from '@roomote/db/server';
import { acknowledgeSessionBrowserAttention } from '@roomote/sdk/server';

import { authorize } from '@/lib/server/auth-context';
import { findAccessibleSession } from '@/lib/server/sessions';

export const runtime = 'nodejs';

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const bodySchema = z.object({
  notificationId: z.string().uuid(),
  clientId: z.string().uuid(),
  action: z.enum(['accepted', 'failed', 'opened']),
});

export async function POST(
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
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!params.success || !body.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const session = await findAccessibleSession(auth, params.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  const result = await acknowledgeSessionBrowserAttention({
    sessionId: session.id,
    userId: auth.userId,
    ...body.data,
  });
  return NextResponse.json({ result });
}
