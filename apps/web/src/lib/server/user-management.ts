import {
  and,
  authAccounts,
  authUsers,
  db,
  deploymentSettings,
  eq,
  isNull,
  ne,
  slackUserMappings,
  telegramUserMappings,
  users,
} from '@roomote/db/server';
import type { UserRole } from '@roomote/types';

import {
  capturePasswordResetLink,
  getAuth,
  PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
} from './auth';
import { Env } from './env';

const DEFAULT_DEPLOYMENT_ID = 'default';
const CREDENTIAL_PROVIDER_ID = 'credential';

type UpdateUserRoleResult =
  | { updated: true }
  | {
      updated: false;
      reason: 'not_found' | 'own_role' | 'last_admin';
    };

type RemoveUserResult =
  | { removed: true }
  | {
      removed: false;
      reason: 'not_found' | 'own_account' | 'last_admin';
    };

type PasswordResetLinkResult =
  | { created: true; url: string; expiresAt: Date }
  | { created: false; reason: 'not_found' | 'oauth_only' | 'not_generated' };

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Deployment-wide mutex for membership mutations (role changes, removals).
 * Serializing on the single deployment_settings row keeps two concurrent
 * mutations from each passing the "another admin remains" check and leaving
 * the deployment with zero admins.
 */
async function lockDeploymentMembership(tx: Transaction): Promise<void> {
  await tx
    .select({ id: deploymentSettings.id })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .for('update');
}

async function hasOtherActiveAdmin(
  tx: Transaction,
  excludedUserId: string,
): Promise<boolean> {
  const [otherAdmin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        isNull(users.deletedAt),
        ne(users.id, excludedUserId),
      ),
    )
    .limit(1);

  return otherAdmin != null;
}

/**
 * Change a user's deployment role, preserving the invariant that at least
 * one active admin always remains.
 *
 * Admins cannot change their own role; promoting someone else first is the
 * only way for the last admin to step down. If a deployment still ends up
 * admin-less (e.g. via manual database edits), recovery is a direct database
 * update — see SELF_HOSTING.md.
 */
export async function updateUserRole({
  actorUserId,
  targetUserId,
  role,
}: {
  actorUserId: string;
  targetUserId: string;
  role: UserRole;
}): Promise<UpdateUserRoleResult> {
  if (targetUserId === actorUserId) {
    return { updated: false, reason: 'own_role' };
  }

  return db.transaction(async (tx) => {
    await lockDeploymentMembership(tx);

    const target = await tx.query.users.findFirst({
      where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
    });

    if (!target) {
      return { updated: false, reason: 'not_found' } as const;
    }

    if (target.role === role) {
      return { updated: true } as const;
    }

    if (role === 'member' && !(await hasOtherActiveAdmin(tx, targetUserId))) {
      return { updated: false, reason: 'last_admin' } as const;
    }

    await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));

    return { updated: true } as const;
  });
}

/**
 * Remove a user from the deployment, under the same guards and lock as role
 * changes: you cannot remove yourself, and removing the last active admin is
 * refused.
 *
 * The app user row is soft-deleted so task history keeps its attribution,
 * while the Better Auth user row is hard-deleted — cascading away sessions
 * (immediate sign-out) and OAuth account links, and freeing the unique email
 * so the same person can sign up again later. A re-signup arrives as a
 * brand-new user and must pass the sign-in access checks (invite or org
 * membership) like anyone else.
 */
export async function removeUser({
  actorUserId,
  targetUserId,
}: {
  actorUserId: string;
  targetUserId: string;
}): Promise<RemoveUserResult> {
  if (targetUserId === actorUserId) {
    return { removed: false, reason: 'own_account' };
  }

  return db.transaction(async (tx) => {
    await lockDeploymentMembership(tx);

    const target = await tx.query.users.findFirst({
      where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
    });

    if (!target) {
      return { removed: false, reason: 'not_found' } as const;
    }

    if (
      target.role === 'admin' &&
      !(await hasOtherActiveAdmin(tx, targetUserId))
    ) {
      return { removed: false, reason: 'last_admin' } as const;
    }

    const now = new Date();

    await tx
      .update(users)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(users.id, targetUserId));

    await tx
      .delete(slackUserMappings)
      .where(eq(slackUserMappings.userId, targetUserId));

    await tx
      .delete(telegramUserMappings)
      .where(eq(telegramUserMappings.userId, targetUserId));

    await tx.delete(authUsers).where(eq(authUsers.id, targetUserId));

    return { removed: true } as const;
  });
}

function getPasswordResetRedirectUrl(): string {
  return new URL(
    '/reset-password',
    Env.ROOMOTE_PUBLIC_URL ?? Env.ROOMOTE_APP_URL,
  ).href;
}

export async function createPasswordResetLinkForUser({
  targetUserId,
}: {
  targetUserId: string;
}): Promise<PasswordResetLinkResult> {
  const target = await db.query.users.findFirst({
    where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
  });

  if (!target) {
    return { created: false, reason: 'not_found' };
  }

  const credentialAccount = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, targetUserId),
      eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID),
    ),
  });

  if (!credentialAccount) {
    return { created: false, reason: 'oauth_only' };
  }

  const auth = await getAuth();
  const url = await capturePasswordResetLink(async () => {
    await auth.api.requestPasswordReset({
      body: {
        email: target.email,
        redirectTo: getPasswordResetRedirectUrl(),
      },
    });
  });

  if (!url) {
    return { created: false, reason: 'not_generated' };
  }

  return {
    created: true,
    url,
    expiresAt: new Date(
      Date.now() + PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS * 1000,
    ),
  };
}

export async function userHasCredentialAccount(
  userId: string,
): Promise<boolean> {
  const credentialAccount = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.userId, userId),
      eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID),
    ),
  });

  return credentialAccount != null;
}
