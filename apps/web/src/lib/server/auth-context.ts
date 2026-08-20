import { headers } from 'next/headers';
import { APIError } from 'better-auth/api';

import {
  db,
  deploymentSettings,
  eq,
  invites,
  resolveBrainAvailability,
  recordLicenseUsageObservation,
  users,
} from '@roomote/db/server';
import type { UserRole } from '@roomote/types';
import {
  evaluateFeatureFlagsFromMetadata,
  isAnonymousAnalyticsEnabledFromMetadata,
  normalizeMetadataRecord,
} from '@roomote/feature-flags';
import { getManagedDeploymentAccessFromMetadata } from '@roomote/types';
import {
  requestInstancePing,
  requestLicenseUsageSync,
} from '@roomote/sdk/server/request-instance-ping';
import { isTelemetryEnvAllowed } from '@roomote/telemetry/server';

import {
  type AuthError,
  type UserAuthSuccess,
  type UserResource,
} from '@/types';

import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';
import { Env, isRoomoteCloudEnabled } from './env';
import { setSentryUserContext } from './sentry-context';
import { getAuth } from './auth';
import {
  evaluateSignInAccess,
  seedDeploymentAccessPolicyIfNeeded,
} from './access-policy';
import { InviteRedemptionFailedError, redeemInvite } from './invites';
import { assertSeatAvailable, SeatLimitExceededError } from './license';

const DEFAULT_DEPLOYMENT_ID = 'default';

type SignedInAuthContext = {
  success: true;
  userId: string;
  name: string;
  primaryEmail: string;
  deploymentMetadata: Record<string, unknown>;
  isAdmin: boolean;
  cookieConsentedAt: number | null;
  resource: UserResource;
};

type SignedInAuthContextOptions = {
  treatPendingAsSignedOut?: boolean;
};

async function loadDeploymentIdentityState(userId: string) {
  const [existingDeploymentSettings, existingUser] = await Promise.all([
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    }),
    db.query.users.findFirst({
      where: eq(users.id, userId),
    }),
  ]);

  return { existingDeploymentSettings, existingUser };
}

type DeploymentIdentityState = Awaited<
  ReturnType<typeof loadDeploymentIdentityState>
>;

function createUserResource({
  userId,
  name,
  email,
  imageUrl,
  createdAt,
}: {
  userId: string;
  name: string;
  email: string;
  imageUrl?: string | null;
  createdAt?: Date | number | null;
}): UserResource {
  return {
    username: userId,
    fullName: name,
    firstName: name.split(' ')[0] || null,
    lastName: name.split(' ').slice(1).join(' ') || null,
    primaryEmailAddress: {
      id: `${userId}-email`,
      emailAddress: email,
    },
    emailAddresses: [
      {
        id: `${userId}-email`,
        emailAddress: email,
      },
    ],
    imageUrl: imageUrl ?? '',
    createdAt: createdAt ?? null,
  };
}

async function ensureDeploymentIdentity({
  userId,
  name,
  email,
  imageUrl,
  invitedByInviteId,
  admittedViaBootstrap,
  identityState,
}: {
  userId: string;
  name: string;
  email: string;
  imageUrl?: string | null;
  invitedByInviteId?: string | null;
  admittedViaBootstrap?: boolean;
  identityState: DeploymentIdentityState;
}) {
  const now = new Date();
  let deploymentMetadata: Record<string, unknown>;
  const { existingDeploymentSettings, existingUser } = identityState;

  if (existingDeploymentSettings) {
    deploymentMetadata = normalizeMetadataRecord(
      existingDeploymentSettings.metadata,
    );
  } else {
    deploymentMetadata = {};

    await db.insert(deploymentSettings).values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata: deploymentMetadata,
      setupCompletedAt: null,
    });
  }

  const userEntity = {
    id: userId,
    name,
    email,
    imageUrl: imageUrl ?? '',
  };

  let role: UserRole;

  if (!existingUser) {
    // Invite redemption is bound to the user-row insert in one transaction:
    // a use is consumed exactly once per admitted user (parallel first-load
    // requests conflict on the insert and skip redemption), and a failed
    // insert can never burn an invite use.
    role = await db.transaction(async (tx) => {
      // Seat gate (license key functionality under FCL-1.0-ALv2): admission
      // is only allowed below the deployment's seat limit.
      await assertSeatAvailable(tx);

      // The deployment's first user is its founding admin; everyone after
      // joins with their invite's role, or as a member for org-membership
      // sign-ins, until an admin changes it. Setup-token holders are
      // deployment operators, so bootstrap admissions during open setup join
      // as admins even when an earlier aborted attempt left an account
      // behind.
      const [anyUser] = await tx.select({ id: users.id }).from(users).limit(1);

      let insertRole: UserRole = 'admin';

      if (anyUser && !admittedViaBootstrap) {
        const invite = invitedByInviteId
          ? await tx.query.invites.findFirst({
              where: eq(invites.id, invitedByInviteId),
            })
          : null;

        insertRole = invite?.role ?? 'member';
      }

      const inserted = await tx
        .insert(users)
        .values({
          id: userId,
          name,
          email,
          imageUrl: imageUrl ?? '',
          entity: userEntity,
          metadata: {},
          role: insertRole,
          // New Members link their personal accounts before using Roomote.
          onboardingCompletedAt: insertRole === 'member' ? null : now,
          invitedByInviteId: invitedByInviteId ?? null,
        })
        .onConflictDoNothing({ target: users.id })
        .returning({ id: users.id });

      if (inserted.length === 0) {
        // A concurrent request inserted this user first; its row is the
        // source of truth for the role.
        const concurrentUser = await tx.query.users.findFirst({
          where: eq(users.id, userId),
        });

        return concurrentUser?.role ?? insertRole;
      }

      if (!invitedByInviteId) {
        await recordLicenseUsageObservation(tx, now);
        return insertRole;
      }

      if (!(await redeemInvite(invitedByInviteId, tx))) {
        // Rolls back the user row so the visitor is denied instead of
        // slipping past an invite exhausted by a concurrent redemption.
        throw new InviteRedemptionFailedError();
      }

      await recordLicenseUsageObservation(tx, now);
      return insertRole;
    });

    await seedDeploymentAccessPolicyIfNeeded({ userId });

    // A new admission changes the instance's user counts; refresh the
    // anonymous report instead of waiting for the daily tick.
    void requestInstancePing('user-admitted');
    void requestLicenseUsageSync('user-admitted');
  } else {
    // Removal deletes the Better Auth user, so a removed user normally can
    // never reach this branch again. If a soft-deleted row's auth user still
    // exists (e.g. a manual database edit) and access policy re-admits them,
    // restore the row as a member rather than leaving it in limbo.
    const isRestoring = existingUser.deletedAt != null;
    role = admittedViaBootstrap
      ? 'admin'
      : isRestoring
        ? 'member'
        : existingUser.role;

    const desiredImageUrl = imageUrl ?? existingUser.imageUrl;
    const profileUpdate = {
      name,
      email,
      imageUrl: desiredImageUrl,
      entity: userEntity,
      // A null timestamp is intentional for an incomplete Member. Do not turn
      // later authentication checks into an implicit onboarding completion.
      onboardingCompletedAt: existingUser.onboardingCompletedAt,
      updatedAt: now,
      ...(admittedViaBootstrap && existingUser.role !== 'admin'
        ? { role }
        : {}),
    };

    if (isRestoring) {
      // Restoring a soft-deleted row re-occupies a seat, so it passes the
      // same serialized gate as a new admission: the seat check and the
      // deletedAt-clearing update commit atomically, with the settings row
      // locked so a concurrent admission cannot pass the gate alongside it.
      await db.transaction(async (tx) => {
        await assertSeatAvailable(tx);

        await tx
          .update(users)
          .set({ ...profileUpdate, deletedAt: null, role })
          .where(eq(users.id, userId));
        await recordLicenseUsageObservation(tx, now);
      });
      void requestLicenseUsageSync('user-restored');
    } else if (
      existingUser.name !== name ||
      existingUser.email !== email ||
      existingUser.imageUrl !== desiredImageUrl ||
      (admittedViaBootstrap && existingUser.role !== 'admin') ||
      !isMatchingUserEntity(existingUser.entity, userEntity)
    ) {
      await db.update(users).set(profileUpdate).where(eq(users.id, userId));
    }
  }

  return {
    deploymentMetadata,
    role,
    cookieConsentedAt: existingUser?.cookieConsentedAt?.getTime() ?? null,
    resource: createUserResource({
      userId,
      name,
      email,
      imageUrl,
      createdAt: existingUser?.createdAt ?? now,
    }),
  };
}

function isMatchingUserEntity(
  value: unknown,
  expected: { id: string; name: string; email: string; imageUrl: string },
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const entity = value as Record<string, unknown>;

  return (
    Object.keys(entity).length === 4 &&
    entity.id === expected.id &&
    entity.name === expected.name &&
    entity.email === expected.email &&
    entity.imageUrl === expected.imageUrl
  );
}

async function getBetterAuthSession() {
  const auth = await getAuth();

  try {
    return await auth.api.getSession({
      headers: await headers(),
    });
  } catch (error) {
    // Invalid or expired auth cookies should behave like a signed-out
    // visitor on server renders instead of crashing the whole page.
    if (error instanceof APIError && error.statusCode === 401) {
      return null;
    }

    throw error;
  }
}

export async function getSignedInAuthContext(
  _options?: SignedInAuthContextOptions,
): Promise<SignedInAuthContext | AuthError> {
  await bootstrapWebRuntimeEnv();

  const session = await getBetterAuthSession();

  if (!session) {
    return { success: false, error: 'Unauthorized: User required' };
  }

  const sessionUser = session.user;
  const userId = sessionUser.id;
  const name = sessionUser.name || sessionUser.email;
  const primaryEmail = sessionUser.email;
  const imageUrl = sessionUser.image ?? '';

  const [accessDecision, identityState] = await Promise.all([
    evaluateSignInAccess({
      userId,
      email: primaryEmail,
    }),
    loadDeploymentIdentityState(userId),
  ]);

  if (!accessDecision.allowed) {
    return { success: false, error: 'Unauthorized: Not a member' };
  }

  const invitedByInviteId =
    accessDecision.via === 'invite' ? (accessDecision.inviteId ?? null) : null;

  let identity: Awaited<ReturnType<typeof ensureDeploymentIdentity>>;

  try {
    identity = await ensureDeploymentIdentity({
      userId,
      name,
      email: primaryEmail,
      imageUrl,
      invitedByInviteId,
      admittedViaBootstrap: accessDecision.via === 'bootstrap',
      identityState,
    });
  } catch (error) {
    if (error instanceof InviteRedemptionFailedError) {
      return {
        success: false,
        error: 'Unauthorized: Invite is no longer valid',
      };
    }

    if (error instanceof SeatLimitExceededError) {
      return {
        success: false,
        error:
          'Unauthorized: This deployment has reached its licensed user limit',
        reason: 'seat_limit',
      };
    }

    throw error;
  }

  const { cookieConsentedAt, deploymentMetadata, role, resource } = identity;

  setSentryUserContext({
    id: userId,
  });

  return {
    success: true,
    userId,
    name,
    primaryEmail,
    deploymentMetadata,
    isAdmin: role === 'admin',
    cookieConsentedAt,
    resource,
  };
}

export async function authorize(): Promise<UserAuthSuccess | AuthError> {
  const authContext = await getSignedInAuthContext();

  if (!authContext.success) {
    return authContext;
  }

  const featureFlags = evaluateFeatureFlagsFromMetadata(
    authContext.deploymentMetadata,
  );

  const anonymousAnalyticsEnabled =
    isTelemetryEnvAllowed() &&
    isAnonymousAnalyticsEnabledFromMetadata(
      authContext.deploymentMetadata,
      isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
    );

  return {
    success: true,
    userType: 'user',
    userId: authContext.userId,
    name: authContext.name,
    primaryEmail: authContext.primaryEmail,
    isAdmin: authContext.isAdmin,
    featureFlags,
    anonymousAnalyticsEnabled,
    cloudEnabled: isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
    ...(await (async () => {
      const brainAvailability = await resolveBrainAvailability();
      return {
        brainConfigured: brainAvailability === 'configured',
        brainNeedsKey: brainAvailability === 'managed_needs_key',
      };
    })()),
    cookieConsentedAt: authContext.cookieConsentedAt,
    managedAccess: getManagedDeploymentAccessFromMetadata(
      authContext.deploymentMetadata,
    ),
    resource: authContext.resource,
  };
}

export async function authorizeOrThrow(): Promise<UserAuthSuccess> {
  const result = await authorize();

  if (!result.success) {
    throw new Error(result.error);
  }

  return result;
}
