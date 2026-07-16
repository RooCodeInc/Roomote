import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  MAX_TELEMETRY_BATCH_SIZE,
  TELEMETRY_EVENT_NAME_PATTERN,
} from '@roomote/telemetry';
import {
  captureEvent,
  isAnonymousAnalyticsEnabled,
} from '@roomote/telemetry/server';

import { authorize } from '@/lib/server/auth-context';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';

export const runtime = 'nodejs';

const propertyValueSchema = z.union([
  z.string().max(512),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(256)).max(20),
]);

const eventSchema = z.object({
  event: z.string().regex(TELEMETRY_EVENT_NAME_PATTERN),
  properties: z.record(z.string().max(64), propertyValueSchema).optional(),
  timestamp: z.string().datetime().optional(),
});

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(MAX_TELEMETRY_BATCH_SIZE),
});

/**
 * Anonymous analytics relay: the browser never talks to the Ping service
 * directly. Events are attributed server-side to the session user's
 * anonymous analytics id, and the deployment-level opt-out is enforced here
 * regardless of what the client sends.
 */
export async function POST(request: NextRequest) {
  const authResult = await authorize();

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // captureEvent re-checks this per event; checking once up front just
  // avoids pointless id resolution work when analytics is disabled.
  if (
    !(await isAnonymousAnalyticsEnabled(
      isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
    ))
  ) {
    return NextResponse.json({ accepted: 0 }, { status: 202 });
  }

  for (const event of parsed.data.events) {
    void captureEvent(event.event, {
      cloudEnabled: isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
      userId: authResult.userId,
      properties: event.properties,
      timestamp: event.timestamp,
    });
  }

  return NextResponse.json(
    { accepted: parsed.data.events.length },
    { status: 202 },
  );
}
