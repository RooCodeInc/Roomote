import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { revokeRemoteMcpRefreshSession } from '@/lib/server/mcp-remote-oauth';

export const runtime = 'nodejs';

const revocationSchema = z.object({
  token: z.string().min(1),
  client_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const parsed = revocationSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  await revokeRemoteMcpRefreshSession(parsed.data.token, parsed.data.client_id);
  return new NextResponse(null, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
