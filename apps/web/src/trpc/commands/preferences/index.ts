import { db, eq, users } from '@roomote/db/server';
import { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';
import { userHasCredentialAccount } from '@/lib/server/user-management';
import {
  DEFAULT_PERSONAL_PREFERENCES,
  isPersonalColorTheme,
  type PersonalPreferences,
  type PersonalPreferencesUpdate,
} from '@/types/preferences';

type UserMetadataRecord = Record<string, unknown>;

function normalizeMetadata(value: unknown): UserMetadataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as UserMetadataRecord) };
}

function normalizePersonalPreferences(
  metadata: UserMetadataRecord,
  {
    showDebugUISettingEnabled,
  }: {
    showDebugUISettingEnabled: boolean;
  },
): PersonalPreferences {
  return {
    colorTheme: isPersonalColorTheme(metadata.color_theme)
      ? metadata.color_theme
      : DEFAULT_PERSONAL_PREFERENCES.colorTheme,
    narrationMode:
      typeof metadata.narration_mode === 'boolean'
        ? metadata.narration_mode
        : DEFAULT_PERSONAL_PREFERENCES.narrationMode,
    showDebugUI:
      showDebugUISettingEnabled && typeof metadata.show_debug_ui === 'boolean'
        ? metadata.show_debug_ui
        : DEFAULT_PERSONAL_PREFERENCES.showDebugUI,
  };
}

export async function getPersonalPreferencesCommand(
  auth: UserAuthSuccess,
): Promise<PersonalPreferences> {
  const storedUser = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: {
      metadata: true,
    },
  });

  const storedMetadata = normalizeMetadata(storedUser?.metadata);

  return normalizePersonalPreferences(storedMetadata, {
    showDebugUISettingEnabled:
      auth.featureFlags[FeatureFlag.ShowDebugUISetting] === true,
  });
}

export async function getPersonalAccountCapabilitiesCommand(
  auth: UserAuthSuccess,
) {
  return {
    canChangePassword: await userHasCredentialAccount(auth.userId),
  };
}

export async function updatePersonalPreferencesCommand(
  auth: UserAuthSuccess,
  input: PersonalPreferencesUpdate,
): Promise<PersonalPreferences> {
  const showDebugUISettingEnabled =
    auth.featureFlags[FeatureFlag.ShowDebugUISetting] === true;
  const nextMetadataRecord: UserMetadataRecord = {};

  if (input.colorTheme !== undefined) {
    nextMetadataRecord.color_theme = input.colorTheme;
  }

  if (input.narrationMode !== undefined) {
    nextMetadataRecord.narration_mode = input.narrationMode;
  }

  if (input.showDebugUI !== undefined) {
    nextMetadataRecord.show_debug_ui = showDebugUISettingEnabled
      ? input.showDebugUI
      : false;
  }

  if (Object.keys(nextMetadataRecord).length === 0) {
    return getPersonalPreferencesCommand(auth);
  }

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: {
      metadata: true,
    },
  });
  const normalizedMetadata = {
    ...normalizeMetadata(currentUser?.metadata),
    ...nextMetadataRecord,
  };

  const updatedRows = await db
    .update(users)
    .set({
      metadata: normalizedMetadata,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, auth.userId))
    .returning({ id: users.id });

  if (updatedRows.length === 0) {
    throw new Error('Unable to update preferences for the active user.');
  }

  return normalizePersonalPreferences(normalizedMetadata, {
    showDebugUISettingEnabled,
  });
}
