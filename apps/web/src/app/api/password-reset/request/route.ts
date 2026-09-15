import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  isSelfServicePasswordResetAllowed,
  isSelfServicePasswordResetAvailable,
} from '@/lib/server/self-service-password-reset';
import { requestSelfServicePasswordReset } from '@/lib/server/user-management';

export const runtime = 'nodejs';

const requestSchema = z.object({
  email: z.string().trim().email().max(320),
});

const GENERIC_RESPONSE = {
  message:
    'If an active email/password account exists for that address, a reset link will arrive shortly.',
};

function acceptedResponse() {
  return NextResponse.json(GENERIC_RESPONSE, {
    status: 202,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function getClientAddress(request: NextRequest): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    null
  );
}

export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof requestSchema> | null = null;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch {
    return acceptedResponse();
  }

  try {
    if (!(await isSelfServicePasswordResetAvailable())) {
      return acceptedResponse();
    }

    const allowed = await isSelfServicePasswordResetAllowed({
      email: parsed.email,
      clientAddress: getClientAddress(request),
    });
    if (allowed) {
      // Keep the public response independent of account lookup and mail latency.
      after(async () => {
        try {
          await requestSelfServicePasswordReset(parsed.email);
        } catch (error) {
          console.warn(
            '[auth] Self-service password reset delivery failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    }
  } catch (error) {
    console.warn(
      '[auth] Self-service password reset request could not be processed:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return acceptedResponse();
}
