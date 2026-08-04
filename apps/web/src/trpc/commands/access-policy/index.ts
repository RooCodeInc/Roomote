import {
  and,
  authAccounts,
  collectLicensedUserCount,
  db,
  deploymentSettings,
  eq,
  getDeploymentAccountLinkHelpText,
  inArray,
  isNull,
  setDeploymentAccountLinkHelpText,
  users,
} from '@roomote/db/server';
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@roomote/types';
import { captureEvent, syncLicenseWithCloud } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import {
  buildInviteUrl,
  createPasswordResetLinkForUser,
  createInvite,
  FREE_SEAT_LIMIT,
  getDeploymentAccessPolicy,
  getEffectiveDeploymentSeatLimit,
  getDeploymentLicenseState,
  getEnvLicenseKey,
  isInviteUsable,
  listInvites,
  removeUser,
  resolveLicenseState,
  revokeInvite,
  updateUserRole,
} from '@/lib/server';
import { Env } from '@/lib/server/env';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';

const DEFAULT_DEPLOYMENT_ID = 'default';

export async function getAccountLinkHelpCommand(
  auth: UserAuthSuccess,
): Promise<{ helpText: string | null }> {
  assertAdmin(auth);

  return { helpText: await getDeploymentAccountLinkHelpText() };
}

export async function setAccountLinkHelpCommand(
  auth: UserAuthSuccess,
  input: { helpText: string | null },
): Promise<{ helpText: string | null }> {
  assertAdmin(auth);

  return {
    helpText: await setDeploymentAccountLinkHelpText(input.helpText),
  };
}

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

type InviteSummary = {
  id: string;
  label: string | null;
  role: UserRole;
  maxUses: number;
  usedCount: number;
  acceptedUserCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  usable: boolean;
};

type UserSummary = {
  id: string;
  name: string;
  email: string;
  imageUrl: string;
  role: UserRole;
  createdAt: Date;
  hasCredentialAccount: boolean;
};

async function listActiveUsers(): Promise<UserSummary[]> {
  const activeUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      imageUrl: users.imageUrl,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(users.createdAt);

  if (activeUsers.length === 0) {
    return [];
  }

  const credentialAccounts = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        inArray(
          authAccounts.userId,
          activeUsers.map((user) => user.id),
        ),
        eq(authAccounts.providerId, 'credential'),
      ),
    );
  const credentialUserIds = new Set(
    credentialAccounts.map((account) => account.userId),
  );

  return activeUsers.map((user) => ({
    ...user,
    hasCredentialAccount: credentialUserIds.has(user.id),
  }));
}

type LicenseSummary = {
  status: 'unlicensed' | 'invalid' | 'valid' | 'expired';
  seatLimit: number;
  seatsUsed: number;
  freeSeatLimit: number;
  licenseId: string | null;
  licensee: string | null;
  expiresAt: Date | null;
  /** True when `R_LICENSE_KEY` supplies the active key (UI cannot override). */
  fromEnv: boolean;
};

export async function getAccessPolicySettingsCommand(
  auth: UserAuthSuccess,
): Promise<{
  slackTeamId: string | null;
  hasSlackSignIn: boolean;
  hasMicrosoftSignIn: boolean;
  invites: InviteSummary[];
  users: UserSummary[];
  license: LicenseSummary;
}> {
  assertAdmin(auth);

  const [
    policy,
    providerConfig,
    invites,
    activeUsers,
    licenseState,
    seatLimit,
  ] = await Promise.all([
    getDeploymentAccessPolicy(),
    resolveAuthProviderConfig(),
    listInvites(),
    listActiveUsers(),
    getDeploymentLicenseState(),
    getEffectiveDeploymentSeatLimit(),
  ]);

  return {
    license: {
      status: licenseState.status,
      seatLimit,
      seatsUsed: activeUsers.length,
      freeSeatLimit: FREE_SEAT_LIMIT,
      licenseId: 'licenseId' in licenseState ? licenseState.licenseId : null,
      licensee: 'licensee' in licenseState ? licenseState.licensee : null,
      expiresAt: 'expiresAt' in licenseState ? licenseState.expiresAt : null,
      fromEnv: getEnvLicenseKey() != null,
    },
    slackTeamId: policy?.slackTeamId ?? null,
    hasSlackSignIn: Boolean(
      providerConfig.slackClientId && providerConfig.slackClientSecret,
    ),
    hasMicrosoftSignIn: Boolean(
      providerConfig.microsoftClientId &&
      providerConfig.microsoftClientSecret &&
      providerConfig.microsoftTenantId,
    ),
    invites: invites.map((invite) => ({
      id: invite.id,
      label: invite.label,
      role: invite.role,
      maxUses: invite.maxUses,
      usedCount: invite.usedCount,
      acceptedUserCount: invite.acceptedUserCount,
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
      usable: isInviteUsable(invite),
    })),
    users: activeUsers,
  };
}

export async function setLicenseKeyCommand(
  auth: UserAuthSuccess,
  input: { licenseKey: string | null },
): Promise<{ saved: true }> {
  assertAdmin(auth);

  if (getEnvLicenseKey() != null) {
    throw new Error(
      'A license key is already set via the R_LICENSE_KEY environment variable. Update or remove that env var and restart the deployment instead of changing the key here.',
    );
  }

  const licenseKey = input.licenseKey?.trim() || null;

  if (licenseKey != null) {
    const state = resolveLicenseState(licenseKey);

    if (state.status === 'invalid') {
      throw new Error(
        'That license key is not valid. Check that it was copied completely.',
      );
    }

    if (state.status === 'expired') {
      throw new Error(
        'That license key has expired. Refresh it in Roomote Cloud or contact Roomote for help.',
      );
    }

    const usage = await collectLicensedUserCount();
    const activation = await syncLicenseWithCloud({
      eventId: randomUUID(),
      observedAt: new Date(),
      activeUsers: usage.users.total,
      licenseKey,
    });
    if (activation.status === 'license_in_use') {
      throw new Error(
        'That license is already active on another deployment. Contact Roomote support to transfer it.',
      );
    }
    if (activation.status === 'rejected') {
      throw new Error(
        'Roomote Cloud rejected the activation response. Contact Roomote support if this continues.',
      );
    }
    if (activation.status !== 'synced') {
      throw new Error(
        'Roomote Cloud could not activate this license. Check your network connection and try again.',
      );
    }
  }

  if (licenseKey != null) {
    // syncLicenseWithCloud persists the new key and its Cloud lease in one
    // guarded update, so a stale scheduled sync cannot restore an old lease.
    return { saved: true };
  }

  await db
    .update(deploymentSettings)
    .set({ licenseKey: null, licenseCloudState: null, updatedAt: new Date() })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return { saved: true };
}

export async function createInviteCommand(
  auth: UserAuthSuccess,
  input: {
    label?: string;
    role?: UserRole;
    maxUses?: number;
    expiresInDays?: number | null;
  },
): Promise<{ inviteId: string; url: string }> {
  assertAdmin(auth);

  const { invite, token } = await createInvite({
    label: input.label,
    invitedByUserId: auth.userId,
    role: input.role ?? 'member',
    maxUses: input.maxUses ?? 1,
    ttlMs:
      input.expiresInDays == null
        ? undefined
        : input.expiresInDays * 24 * 60 * 60 * 1000,
  });

  // Anonymous analytics (no-op unless enabled): invite creation with the
  // invited role only; no labels, tokens, or emails.
  void captureEvent('user_invited', {
    userId: auth.userId,
    properties: { role: input.role ?? 'member' },
  });

  return {
    inviteId: invite.id,
    // The raw token is only available at creation time; the list endpoint
    // can never reconstruct the link. Build on the public origin: in local
    // dev R_APP_URL is plain-http localhost, which invitees cannot
    // reach and which HTTPS-first browsers refuse to load.
    url: buildInviteUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL, token),
  };
}

export async function revokeInviteCommand(
  auth: UserAuthSuccess,
  input: { inviteId: string },
): Promise<{ revoked: boolean }> {
  assertAdmin(auth);

  return { revoked: await revokeInvite(input.inviteId) };
}

const UPDATE_ROLE_ERRORS = {
  not_found: 'User not found.',
  own_role: 'You cannot change your own role.',
  last_admin: 'Promote another admin before demoting the last one.',
} as const;

export async function updateUserRoleCommand(
  auth: UserAuthSuccess,
  input: { userId: string; role: UserRole },
): Promise<{ updated: true }> {
  assertAdmin(auth);

  const result = await updateUserRole({
    actorUserId: auth.userId,
    targetUserId: input.userId,
    role: input.role,
  });

  if (!result.updated) {
    throw new Error(UPDATE_ROLE_ERRORS[result.reason]);
  }

  return { updated: true };
}

const REMOVE_USER_ERRORS = {
  not_found: 'User not found.',
  own_account: 'You cannot remove yourself.',
  last_admin: 'Promote another admin before removing the last one.',
} as const;

export async function removeUserCommand(
  auth: UserAuthSuccess,
  input: { userId: string },
): Promise<{ removed: true }> {
  assertAdmin(auth);

  const result = await removeUser({
    actorUserId: auth.userId,
    targetUserId: input.userId,
  });

  if (!result.removed) {
    throw new Error(REMOVE_USER_ERRORS[result.reason]);
  }

  return { removed: true };
}

const CREATE_PASSWORD_RESET_LINK_ERRORS = {
  not_found: 'User not found.',
  oauth_only:
    'This user signs in with Slack, Teams, or another OAuth provider.',
  not_generated: 'Unable to generate a password reset link.',
} as const;

export async function createPasswordResetLinkCommand(
  auth: UserAuthSuccess,
  input: { userId: string },
): Promise<{ url: string; expiresAt: Date }> {
  assertAdmin(auth);

  const result = await createPasswordResetLinkForUser({
    targetUserId: input.userId,
  });

  if (!result.created) {
    throw new Error(CREATE_PASSWORD_RESET_LINK_ERRORS[result.reason]);
  }

  return {
    url: result.url,
    expiresAt: result.expiresAt,
  };
}
