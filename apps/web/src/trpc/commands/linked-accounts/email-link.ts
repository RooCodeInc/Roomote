import {
  agentmailUserMappings,
  and,
  asc,
  authUsers,
  db,
  eq,
  resolveAgentMailRuntimeCredentials,
} from '@roomote/db/server';
import { AgentMailApiClient } from '@roomote/communication';
import { getRedis } from '@roomote/redis';
import {
  redispatchAgentMailEventsForSender,
  verifyAgentMailEmailLinkToken,
} from '@roomote/sdk/server';
import { TRPCError } from '@trpc/server';
import { headers } from 'next/headers';

import type { UserAuthSuccess } from '@/types';
import { sendAuthenticatedVerificationEmail } from '@/lib/server/auth';
import { isEmailChannelEnabled } from '@/lib/server/env';
import { SETTINGS_PATHS } from '@/lib/settings';

const INVALID_EMAIL_LINK_TOKEN_MESSAGE =
  'This link is invalid or has expired. Send another email to get a fresh link.';
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

function verifyEmailLinkTokenOrThrow(token: string) {
  const verified = verifyAgentMailEmailLinkToken(token);

  if (!verified) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: INVALID_EMAIL_LINK_TOKEN_MESSAGE,
    });
  }

  return verified;
}

export async function getLinkedEmailAccountsCommand(auth: UserAuthSuccess) {
  const emailEnabled = isEmailChannelEnabled();
  const [authUser, senderMappings, credentials] = await Promise.all([
    db.query.authUsers.findFirst({
      where: eq(authUsers.id, auth.userId),
      columns: { email: true, emailVerified: true },
    }),
    db.query.agentmailUserMappings.findMany({
      where: and(
        eq(agentmailUserMappings.userId, auth.userId),
        eq(agentmailUserMappings.source, 'link_code'),
      ),
      orderBy: [asc(agentmailUserMappings.createdAt)],
      columns: { emailAddress: true },
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
    senderAddresses: senderMappings.map(({ emailAddress }) => emailAddress),
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

export async function previewEmailLinkCommand(
  _auth: UserAuthSuccess,
  token: string,
) {
  const { emailAddress } = verifyEmailLinkTokenOrThrow(token);

  return { emailAddress };
}

export async function linkEmailAddressCommand(
  auth: UserAuthSuccess,
  token: string,
) {
  const { emailAddress } = verifyEmailLinkTokenOrThrow(token);

  const inserted = await db
    .insert(agentmailUserMappings)
    .values({
      emailAddress,
      userId: auth.userId,
      source: 'link_code',
    })
    .onConflictDoNothing({ target: agentmailUserMappings.emailAddress })
    .returning({ id: agentmailUserMappings.id });

  if (inserted.length === 0) {
    const existing = await db.query.agentmailUserMappings.findFirst({
      where: eq(agentmailUserMappings.emailAddress, emailAddress),
      columns: { userId: true },
    });

    if (existing && existing.userId !== auth.userId) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'This email address is already linked to a different Roomote account.',
      });
    }
  }

  const redispatchedCount =
    await redispatchAgentMailEventsForSender(emailAddress);

  return { emailAddress, redispatchedCount };
}
