import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getMcpOAuthRefresh, revokeMcpOAuthRefresh } from '@roomote/redis';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';

export const runtime = 'nodejs';

const revocationSchema = z.object({
  token: z.string().min(1),
  client_id: z.guid(),
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

  await bootstrapWebRuntimeEnv();
  // Adopt a legacy refresh family before revoking it through the same lifecycle.
  await getMcpOAuthRefresh(parsed.data.token);
  await revokeMcpOAuthRefresh(parsed.data.token, parsed.data.client_id);
  return new NextResponse(null, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
