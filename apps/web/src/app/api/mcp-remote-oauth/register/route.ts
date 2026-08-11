import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  isAllowedOAuthRedirectUri,
  isRemoteMcpRegistrationAllowed,
  registerRemoteMcpOAuthClient,
} from '@/lib/server/mcp-remote-oauth';

export const runtime = 'nodejs';

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z
    .array(z.string().max(1_024))
    .min(1)
    .max(5)
    .refine((values) => values.every(isAllowedOAuthRedirectUri)),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2)
    .refine((values) => values.includes('authorization_code'))
    .optional(),
  response_types: z.array(z.literal('code')).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata' },
      { status: 400 },
    );
  }

  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_client_metadata' },
      { status: 400 },
    );
  }

  const registrationFingerprint = JSON.stringify({
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
  });
  try {
    if (!(await isRemoteMcpRegistrationAllowed(registrationFingerprint))) {
      return NextResponse.json(
        { error: 'temporarily_unavailable' },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 503 },
    );
  }

  let client;
  try {
    client = await registerRemoteMcpOAuthClient({
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
    });
  } catch {
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
