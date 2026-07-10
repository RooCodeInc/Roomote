import {
  and,
  authAccounts,
  db,
  deploymentSettings,
  eq,
  isNull,
  not,
  slackInstallations,
  users,
} from '@roomote/db/server';
import {
  type DeploymentAccessPolicy,
  normalizeDeploymentAccessPolicy,
} from '@roomote/types';

import { Env } from './env';
import { isRoomoteEmailAllowed } from './auth-allowlist';
import { resolveAuthProviderConfig } from './auth-provider-config';
import { getRequestInviteToken } from './invite-context';
import { findUsableInviteByToken } from './invites';
import { isSetupBootstrapOpen } from './setup-bootstrap';
import { isSetupTokenValid } from './setup-token';

const DEFAULT_DEPLOYMENT_ID = 'default';
const SLACK_TEAM_ID_CLAIM = 'https://slack.com/team_id';
const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getSlackTeamIdFromIdToken(
  idToken: string | null | undefined,
): string | null {
  if (!idToken) {
    return null;
  }

  const claims = decodeJwtPayload(idToken);
  const teamId = claims?.[SLACK_TEAM_ID_CLAIM];

  return typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
}

export async function getDeploymentAccessPolicy(): Promise<DeploymentAccessPolicy | null> {
  const [settings] = await db
    .select({ accessPolicy: deploymentSettings.accessPolicy })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  return normalizeDeploymentAccessPolicy(settings?.accessPolicy ?? null);
}

async function getAuthAccountsForUser(userId: string) {
  return db
    .select({
      providerId: authAccounts.providerId,
      idToken: authAccounts.idToken,
    })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId));
}

async function getActiveSlackInstallationTeamIds(): Promise<Set<string>> {
  const rows = await db
    .select({ teamId: slackInstallations.teamId })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  return new Set(rows.map((row) => row.teamId));
}

async function hasExistingAppUser(userId: string): Promise<boolean> {
  // Removed (soft-deleted) users are not members; they only get back in the
  // way any newcomer does — org membership or a usable invite.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  return existingUser != null;
}

async function hasAnyOtherAppUser(userId: string): Promise<boolean> {
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(not(eq(users.id, userId)))
    .limit(1);

  return existingUser != null;
}

async function isUserInProviderOrg(userId: string): Promise<boolean> {
  const accounts = await getAuthAccountsForUser(userId);

  if (accounts.length === 0) {
    return false;
  }

  const policy = await getDeploymentAccessPolicy();

  for (const account of accounts) {
    // The Microsoft Entra provider is registered with a single tenant id, so
    // completing OAuth already proves tenant membership.
    if (account.providerId === MICROSOFT_ENTRA_PROVIDER_ID) {
      return true;
    }

    if (account.providerId === 'slack') {
      const teamId = getSlackTeamIdFromIdToken(account.idToken);

      if (!teamId) {
        continue;
      }

      if (policy?.slackTeamId) {
        if (teamId === policy.slackTeamId) {
          return true;
        }

        continue;
      }

      const installedTeamIds = await getActiveSlackInstallationTeamIds();

      if (installedTeamIds.has(teamId)) {
        return true;
      }
    }
  }

  return false;
}

type SignInAccessDecision =
  | { allowed: false }
  | {
      allowed: true;
      via: 'existing_user' | 'org_membership' | 'invite' | 'bootstrap';
      inviteId?: string;
    };

/**
 * Full access evaluation for a signed-in (or signing-in) auth user. Access is
 * granted to existing members, provider-organization members (the anchored
 * Slack workspace or the configured Microsoft tenant), holders of a usable
 * invite token, and — as the system invite — anyone presenting a valid
 * SETUP_TOKEN while initial deployment setup remains open (or, in local
 * development only, signing in while setup is open without one). The
 * ROOMOTE_ALLOWED_EMAILS env var stays an additional operator-owned
 * restriction on top.
 */
export async function evaluateSignInAccess({
  userId,
  email,
}: {
  userId: string;
  email: string | null | undefined;
}): Promise<SignInAccessDecision> {
  if (!isRoomoteEmailAllowed(email, Env.ROOMOTE_ALLOWED_EMAILS)) {
    return { allowed: false };
  }

  const inviteToken = await getRequestInviteToken();
  const setupBootstrapOpen = await isSetupBootstrapOpen();

  if (setupBootstrapOpen && Env.SETUP_TOKEN && inviteToken) {
    // The system invite: while initial setup is still open, a valid
    // SETUP_TOKEN admits the deployment operator, even when an earlier
    // aborted setup attempt already left an account behind. Only local
    // development admits a sign-in without one, so an attacker cannot win
    // the first-admin race on an exposed non-local deployment that has not
    // configured SETUP_TOKEN. Once setup completes, this path closes.
    if (isSetupTokenValid(inviteToken ?? undefined)) {
      return { allowed: true, via: 'bootstrap' };
    }
  }

  if (
    setupBootstrapOpen &&
    !Env.SETUP_TOKEN &&
    isSetupTokenValid(undefined) &&
    !(await hasAnyOtherAppUser(userId))
  ) {
    return { allowed: true, via: 'bootstrap' };
  }

  if (await hasExistingAppUser(userId)) {
    return { allowed: true, via: 'existing_user' };
  }

  const invite = await findUsableInviteByToken(inviteToken);

  if (invite) {
    return { allowed: true, via: 'invite', inviteId: invite.id };
  }

  if (await isUserInProviderOrg(userId)) {
    return { allowed: true, via: 'org_membership' };
  }

  return { allowed: false };
}

export async function isSignInAllowedByAccessPolicy({
  userId,
  email,
}: {
  userId: string;
  email: string | null | undefined;
}): Promise<boolean> {
  return (await evaluateSignInAccess({ userId, email })).allowed;
}

/**
 * Whether the current visitor holds standing sign-up rights of their own: a
 * usable invite token from the invite cookie, or — while initial deployment
 * setup remains open — the system invite (a valid SETUP_TOKEN, or nothing in
 * local development). This is what the sign-in page uses to decide whether
 * to offer account creation at all; provider-organization membership (Slack
 * workspace / Microsoft tenant) is a separate admit path evaluated during
 * OAuth.
 */
export async function canVisitorSignUp(): Promise<boolean> {
  const inviteToken = await getRequestInviteToken();

  if (await findUsableInviteByToken(inviteToken)) {
    return true;
  }

  if (await isSetupBootstrapOpen()) {
    if (isSetupTokenValid(inviteToken ?? undefined)) {
      return true;
    }
  }

  return false;
}

/**
 * Early check for brand-new auth users, before any provider account row
 * exists (this also gates email/password sign-up). Admits when a usable
 * invite or the system invite is presented, or when the deployment is empty.
 * OAuth sign-ins from an org-scoped provider configuration are additionally
 * admitted here so the full org-membership check can run at session creation
 * once the provider account row exists — email/password sign-ups have no org
 * membership to defer to, so they strictly require an invite.
 */
export async function isNewAuthUserEmailAllowed(
  email: string | null | undefined,
  { isCredentialSignUp = false }: { isCredentialSignUp?: boolean } = {},
): Promise<boolean> {
  if (!isRoomoteEmailAllowed(email, Env.ROOMOTE_ALLOWED_EMAILS)) {
    return false;
  }

  if (await canVisitorSignUp()) {
    return true;
  }

  if (isCredentialSignUp) {
    return false;
  }

  const providerConfig = await resolveAuthProviderConfig();

  return Boolean(
    (providerConfig.slackClientId && providerConfig.slackClientSecret) ||
    (providerConfig.microsoftClientId &&
      providerConfig.microsoftClientSecret &&
      providerConfig.microsoftTenantId),
  );
}

/**
 * Anchor the deployment's Slack workspace from the first signed-in user, so
 * later "anyone in your Slack workspace" checks compare against the founding
 * workspace rather than whichever workspace authorizes first. No-op when a
 * policy already exists.
 */
export async function seedDeploymentAccessPolicyIfNeeded({
  userId,
}: {
  userId: string;
}): Promise<void> {
  const [existing] = await db
    .select({ accessPolicy: deploymentSettings.accessPolicy })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  if (existing?.accessPolicy != null) {
    return;
  }

  const accounts = await getAuthAccountsForUser(userId);
  const slackAccount = accounts.find(
    (account) => account.providerId === 'slack',
  );
  const policy: DeploymentAccessPolicy = {
    slackTeamId: slackAccount
      ? getSlackTeamIdFromIdToken(slackAccount.idToken)
      : null,
  };

  await db
    .update(deploymentSettings)
    .set({
      accessPolicy: policy,
      updatedAt: new Date(),
    })
    .where(
      // The isNull guard keeps a concurrent first sign-in from overwriting
      // an already-seeded policy.
      and(
        eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
        isNull(deploymentSettings.accessPolicy),
      ),
    );
}
