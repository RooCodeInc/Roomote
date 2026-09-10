import { agentmailUserMappings, db, eq } from '@roomote/db/server';
import {
  redispatchAgentMailEventsForSender,
  verifyAgentMailEmailLinkToken,
} from '@roomote/sdk/server';
import { TRPCError } from '@trpc/server';

import type { UserAuthSuccess } from '@/types';

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
