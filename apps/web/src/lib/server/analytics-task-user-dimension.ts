import {
  type EffectiveAuthorKind,
  PRODUCT_NAME,
  type TaskAttributionKind,
  type TaskAttributionSourceKind,
} from '@roomote/types';
import { resolveTaskAttributionDisplay } from '@roomote/db/server';
import { getUserDisplayName } from '@/lib/user-display-name';

export const AUTOMATIONS_USER_DIMENSION_KEY = 'automations';
export const AUTOMATIONS_USER_DIMENSION_LABEL = 'Automations';

type AnalyticsUserDimensionValue = {
  key: string;
  label: string;
  disambiguationLabel?: string;
};

function formatUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  return getUserDisplayName(user) || PRODUCT_NAME;
}

function formatDisambiguatedUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  const displayName = getUserDisplayName(user);

  if (displayName && user?.email) {
    return `${displayName} (${user.email})`;
  }

  return formatUserLabel(user);
}

function createDimensionValue(
  key: string,
  label: string,
  disambiguationLabel?: string,
): AnalyticsUserDimensionValue {
  return {
    key,
    label,
    ...(disambiguationLabel &&
    disambiguationLabel !== label &&
    disambiguationLabel.trim()
      ? { disambiguationLabel }
      : {}),
  };
}

function getCanonicalUserDimensionValue(user: {
  id: string | null;
  name: string | null;
  email: string | null;
}): AnalyticsUserDimensionValue {
  const label = formatUserLabel(user);
  const normalizedEmail = user.email?.trim().toLowerCase() ?? null;
  const key = user.id
    ? `user:${user.id}`
    : normalizedEmail
      ? `email:${normalizedEmail}`
      : PRODUCT_NAME;

  return createDimensionValue(key, label, formatDisambiguatedUserLabel(user));
}

/**
 * Canonical "By User" dimension for task analytics.
 * Matched product users keep their own series. Named automations each get
 * their series (e.g. "PR Reviewer", "Suggest Ideas"). Other automatic work
 * falls back to a shared Automations series. Residual unlinked identities
 * keep their own label so they are not mislabeled as an automation.
 */
export function getCanonicalTaskAttributionDimensionValue(input: {
  attributionKind: TaskAttributionKind | null;
  attributedUserId: string | null;
  attributionSourceKind: TaskAttributionSourceKind | null;
  attributionSourceDisplayName: string | null;
  attributionSourceExternalId: string | null;
  attributedGithubLogin: string | null;
  effectiveAuthorKind: EffectiveAuthorKind | null;
  effectiveAuthorUserId: string | null;
  effectiveAuthorDisplayName: string | null;
  effectiveAuthorGithubLogin: string | null;
  userName: string | null;
  userEmail: string | null;
}): AnalyticsUserDimensionValue {
  const attribution = resolveTaskAttributionDisplay(
    {
      attributionKind: input.attributionKind,
      attributedUserId: input.attributedUserId,
      attributionSourceKind: input.attributionSourceKind,
      attributionSourceDisplayName: input.attributionSourceDisplayName,
      attributionSourceExternalId: input.attributionSourceExternalId,
      attributedGithubLogin: input.attributedGithubLogin,
      effectiveAuthorKind: input.effectiveAuthorKind,
      effectiveAuthorUserId: input.effectiveAuthorUserId,
      effectiveAuthorDisplayName: input.effectiveAuthorDisplayName,
      effectiveAuthorGithubLogin: input.effectiveAuthorGithubLogin,
    },
    {
      attributedUser: {
        id: input.attributedUserId,
        name: input.userName,
        email: input.userEmail,
      },
    },
  );

  if (attribution.kind === 'matched_user') {
    const matchedUserId =
      input.effectiveAuthorKind === 'human' && input.effectiveAuthorUserId
        ? input.effectiveAuthorUserId
        : input.attributedUserId;
    const matchedUserName =
      input.effectiveAuthorKind === 'human' &&
      input.effectiveAuthorDisplayName &&
      input.effectiveAuthorUserId !== input.attributedUserId
        ? input.effectiveAuthorDisplayName
        : input.userName;
    const matchedUserEmail =
      matchedUserId && matchedUserId === input.attributedUserId
        ? input.userEmail
        : null;

    return getCanonicalUserDimensionValue({
      id: matchedUserId,
      name: matchedUserName,
      email: matchedUserEmail,
    });
  }

  if (attribution.kind === 'automatic') {
    const label = attribution.analyticsDisplay?.trim() || PRODUCT_NAME;
    if (
      !label ||
      label === PRODUCT_NAME ||
      label === AUTOMATIONS_USER_DIMENSION_LABEL
    ) {
      return createDimensionValue(
        AUTOMATIONS_USER_DIMENSION_KEY,
        AUTOMATIONS_USER_DIMENSION_LABEL,
      );
    }

    return createDimensionValue(`automation:${label}`, label);
  }

  // Unlinked external identities still show their own label.
  const unlinkedLabel =
    attribution.analyticsDisplay?.trim() || AUTOMATIONS_USER_DIMENSION_LABEL;
  const unlinkedKey =
    input.attributionSourceExternalId != null &&
    input.attributionSourceExternalId.trim()
      ? `unlinked:${input.attributionSourceKind}:${input.attributionSourceExternalId}`
      : `unlinked:${unlinkedLabel}`;

  return createDimensionValue(unlinkedKey, unlinkedLabel);
}
