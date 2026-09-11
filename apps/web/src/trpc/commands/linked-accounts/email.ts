import {
  authUsers,
  db,
  eq,
  resolveAgentMailRuntimeCredentials,
} from '@roomote/db/server';
import { AgentMailApiClient } from '@roomote/communication';
import { getRedis } from '@roomote/redis';
import { TRPCError } from '@trpc/server';
import { headers } from 'next/headers';

import type { UserAuthSuccess } from '@/types';
import { sendAuthenticatedVerificationEmail } from '@/lib/server/auth';
import { isEmailChannelEnabled } from '@/lib/server/env';
import { SETTINGS_PATHS } from '@/lib/settings';

const VERIFICATION_RESEND_WINDOW_SECONDS = 60;
const VERIFICATION_RESEND_MAX_ATTEMPTS = 3;

async function enforceVerificationResendRateLimit(userId: string) {
  const attempts = Number(
    await getRedis().eval(
      `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`,
      1,
      `email-verification-resend:${userId}`,
      String(VERIFICATION_RESEND_WINDOW_SECONDS),
    ),
  );

  if (attempts > VERIFICATION_RESEND_MAX_ATTEMPTS) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many verification requests. Try again shortly.',
    });
  }
}

export async function getLinkedEmailAccountsCommand(auth: UserAuthSuccess) {
  const emailEnabled = isEmailChannelEnabled();
  const [authUser, credentials] = await Promise.all([
    db.query.authUsers.findFirst({
      where: eq(authUsers.id, auth.userId),
      columns: { email: true, emailVerified: true },
    }),
    emailEnabled ? resolveAgentMailRuntimeCredentials() : Promise.resolve(null),
  ]);
  const verificationDeliveryAvailable = Boolean(
    emailEnabled && credentials?.apiKey && credentials.inboxId,
  );
  let inboxEmail: string | null = null;

  if (auth.isAdmin && credentials?.apiKey && credentials.inboxId) {
    try {
      const inbox = await new AgentMailApiClient({
        apiKey: credentials.apiKey,
      }).getInbox(credentials.inboxId);
      inboxEmail = inbox.email?.trim().toLowerCase() || null;
    } catch {
      inboxEmail = null;
    }
  }

  return {
    emailEnabled,
    verificationDeliveryAvailable,
    primaryEmail: authUser
      ? {
          emailAddress: authUser.email,
          verified: authUser.emailVerified,
        }
      : null,
    canViewInboxAddress: auth.isAdmin,
    inboxEmail,
  };
}

export async function resendPrimaryEmailVerificationCommand(
  auth: UserAuthSuccess,
) {
  if (!auth.primaryEmail) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No login email is available for this account.',
    });
  }

  await enforceVerificationResendRateLimit(auth.userId);
  await sendAuthenticatedVerificationEmail({
    email: auth.primaryEmail,
    callbackURL: SETTINGS_PATHS.personal,
    headers: await headers(),
  });
}
