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
import {
  redispatchAgentMailEventsForSender,
  verifyAgentMailEmailLinkToken,
} from '@roomote/sdk/server';
import { TRPCError } from '@trpc/server';

import type { UserAuthSuccess } from '@/types';
import { isEmailChannelEnabled } from '@/lib/server/env';

const INVALID_EMAIL_LINK_TOKEN_MESSAGE =
  'This link is invalid or has expired. Send another email to get a fresh link.';

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
