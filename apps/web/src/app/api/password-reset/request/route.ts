import { randomUUID } from 'node:crypto';

import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  isSelfServicePasswordResetAllowed,
  isSelfServicePasswordResetAvailable,
} from '@/lib/server/self-service-password-reset';
import { requestSelfServicePasswordReset } from '@/lib/server/user-management';
import { logger } from '@/lib/server/logger';
import { Env, resolveTrustedClientAddress } from '@/lib/server/env';

export const runtime = 'nodejs';

const requestSchema = z.object({
  email: z.string().trim().email().max(320),
});

const GENERIC_RESPONSE = {
  message:
    'If an active email/password account exists for that address, a reset link will arrive shortly.',
};

function acceptedResponse(requestId: string) {
  return NextResponse.json(GENERIC_RESPONSE, {
    status: 202,
    headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
  });
}

function getClientAddress(request: NextRequest): string | null {
  return resolveTrustedClientAddress(
    request.headers,
    Env.R_TRUSTED_PROXY_CLIENT_IP_HEADER,
  );
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let parsed: z.infer<typeof requestSchema> | null = null;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch {
    logger.info(
      { event: 'password_reset_request', outcome: 'invalid_input', requestId },
      'Password reset request completed',
    );
    return acceptedResponse(requestId);
  }

  try {
    if (!(await isSelfServicePasswordResetAvailable())) {
      logger.info(
        { event: 'password_reset_request', outcome: 'unavailable', requestId },
        'Password reset request completed',
      );
      return acceptedResponse(requestId);
    }

    const allowed = await isSelfServicePasswordResetAllowed({
      email: parsed.email,
      clientAddress: getClientAddress(request),
    });
    if (allowed) {
      // Keep the public response independent of account lookup and mail latency.
      after(async () => {
        try {
          const outcome = await requestSelfServicePasswordReset(parsed.email);
          logger.info(
            { event: 'password_reset_request', outcome, requestId },
            'Password reset request completed',
          );
        } catch (error) {
          logger.warn(
            {
              errorType: error instanceof Error ? error.name : typeof error,
              event: 'password_reset_request',
              outcome: 'delivery_threw',
              requestId,
            },
            'Password reset request delivery failed',
          );
        }
      });
    } else {
      logger.info(
        { event: 'password_reset_request', outcome: 'rate_limited', requestId },
        'Password reset request completed',
      );
    }
  } catch (error) {
    logger.warn(
      {
        errorType: error instanceof Error ? error.name : typeof error,
        event: 'password_reset_request',
        outcome: 'processing_failed',
        requestId,
      },
      'Password reset request could not be processed',
    );
  }

  return acceptedResponse(requestId);
}
