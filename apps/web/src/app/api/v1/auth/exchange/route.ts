import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { readBoundedJsonBody } from '@/lib/server/bounded-json-body';
import { consumeMobileHandoffToken } from '@/lib/server/mobile-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ code: z.string().min(1).max(128) });

/** Trade a mobile-handoff code for the session token it was minted for. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readBoundedJsonBody(request, {
    maxBytes: 4096,
    timeoutMs: 5_000,
  });
  const parsed = body.ok ? bodySchema.safeParse(body.value) : null;
  if (!parsed?.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const token = await consumeMobileHandoffToken(parsed.data.code);
  if (!token) {
    return NextResponse.json(
      { error: 'Code is invalid or expired' },
      { status: 401 },
    );
  }
  return NextResponse.json({ token });
}
