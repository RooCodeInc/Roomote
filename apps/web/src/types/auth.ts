import { FeatureFlag } from '@roomote/feature-flags';
import type { ManagedDeploymentAccess } from '@roomote/types';

/**
 * Authentication
 */

export type UserResource = {
  username: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: { id: string; emailAddress: string } | null;
  emailAddresses: { id: string; emailAddress: string }[];
  imageUrl: string;
  createdAt: Date | number | null;
};

export type AuthorizedUser = {
  userId: string;
  name: string | null;
  primaryEmail: string | null;
  isAdmin: boolean;
  featureFlags: Record<FeatureFlag, boolean>;
  /**
   * Whether anonymous analytics is active for this deployment (admin
   * setting enabled AND the environment allows telemetry). Drives whether
   * the client tracking module is loaded at all.
   */
  anonymousAnalyticsEnabled: boolean;
  /** Whether this deployment uses Roomote Cloud-only behavior. */
  cloudEnabled: boolean;
  /** When this user accepted optional Cloud cookies, serialized as epoch ms. */
  cookieConsentedAt: number | null;
  managedAccess?: ManagedDeploymentAccess;
  resource: UserResource;
};

export type AuthError = {
  success: false;
  error: string;
  /** Machine-readable cause for failures the UI treats specially. */
  reason?: 'seat_limit';
};

export type UserAuthSuccess = {
  success: true;
  userType: 'user';
} & AuthorizedUser;

export type RunAuthTokenSuccess = {
  success: true;
  userType: 'run';
  runId: number;
  /** Null when the run token was minted for the deployment service principal. */
  userId: string | null;
  name: string | null;
  primaryEmail: string | null;
  isAdmin: boolean;
};

export type UserAuthTokenSuccess = {
  success: true;
  userType: 'user';
  userId: string;
  name: string | null;
  primaryEmail: string | null;
  isAdmin: boolean;
};
