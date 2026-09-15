import {
  and,
  db,
  eq,
  getUserPersonalization,
  isNull,
  isSlackPeerConversationsExperimentEnabledInMetadata,
  isPrivateSessionsExperimentEnabledInMetadata,
  PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY,
  SLACK_PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY,
  sql,
  updateUserPersonalization,
  UserPersonalizationConflictError,
  users,
} from '@roomote/db/server';
import { TRPCError } from '@trpc/server';
import { headers } from 'next/headers';
import { SESSION_SECRET_TOOLS_EXPERIMENT_KEY } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getAuth } from '@/lib/server/auth';
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

const VOICE_CONSENT_METADATA_KEY = 'voice_consent_accepted';

function normalizePersonalPreferences(
  metadata: UserMetadataRecord,
): PersonalPreferences {
  return {
    colorTheme: isPersonalColorTheme(metadata.color_theme)
      ? metadata.color_theme
      : DEFAULT_PERSONAL_PREFERENCES.colorTheme,
    mindReaderMode:
      typeof metadata.mind_reader_mode === 'boolean'
        ? metadata.mind_reader_mode
        : DEFAULT_PERSONAL_PREFERENCES.mindReaderMode,
    narrationMode:
      typeof metadata.narration_mode === 'boolean'
        ? metadata.narration_mode
        : DEFAULT_PERSONAL_PREFERENCES.narrationMode,
    resultsPageEnabled:
      typeof metadata.results_page_enabled === 'boolean'
        ? metadata.results_page_enabled
        : DEFAULT_PERSONAL_PREFERENCES.resultsPageEnabled,
    slackPeerConversationsExperimentEnabled:
      isSlackPeerConversationsExperimentEnabledInMetadata(metadata),
    homeComposerSuggestionsEnabled:
      typeof metadata.home_composer_suggestions_enabled === 'boolean'
        ? metadata.home_composer_suggestions_enabled
        : DEFAULT_PERSONAL_PREFERENCES.homeComposerSuggestionsEnabled,
    sessionSecretToolsEnabled:
      typeof metadata[SESSION_SECRET_TOOLS_EXPERIMENT_KEY] === 'boolean'
        ? metadata[SESSION_SECRET_TOOLS_EXPERIMENT_KEY]
        : DEFAULT_PERSONAL_PREFERENCES.sessionSecretToolsEnabled,
    privateSessionsExperimentEnabled:
      isPrivateSessionsExperimentEnabledInMetadata(metadata),
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

  return normalizePersonalPreferences(storedMetadata);
}

export async function getPersonalAccountCapabilitiesCommand(
  auth: UserAuthSuccess,
) {
  const hasCredentialAccount = await userHasCredentialAccount(auth.userId);

  return {
    canChangePassword: hasCredentialAccount,
    canSetPassword: !hasCredentialAccount,
  };
}

export async function setPersonalPasswordCommand(
  _auth: UserAuthSuccess,
  newPassword: string,
) {
  const auth = await getAuth();

  await auth.api.setPassword({
    body: { newPassword },
    headers: await headers(),
  });
}

export async function acceptCookieConsentCommand(
  auth: UserAuthSuccess,
): Promise<Date> {
  if (!auth.cloudEnabled) {
    throw new Error('Cookie consent is only available on Roomote Cloud.');
  }

  const now = new Date();
  const [updatedUser] = await db
    .update(users)
    .set({ cookieConsentedAt: now, updatedAt: now })
    .where(and(eq(users.id, auth.userId), isNull(users.cookieConsentedAt)))
    .returning({ cookieConsentedAt: users.cookieConsentedAt });

  if (updatedUser?.cookieConsentedAt) {
    return updatedUser.cookieConsentedAt;
  }

  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { cookieConsentedAt: true },
  });

  if (!existingUser?.cookieConsentedAt) {
    throw new Error('Unable to record cookie consent for the active user.');
  }

  return existingUser.cookieConsentedAt;
}

export async function getVoiceConsentCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  const storedUser = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { metadata: true },
  });

  return (
    normalizeMetadata(storedUser?.metadata)[VOICE_CONSENT_METADATA_KEY] === true
  );
}

export async function acceptVoiceConsentCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  if (!auth.cloudEnabled) {
    throw new Error('Voice consent is only available on Roomote Cloud.');
  }

  const [updatedUser] = await db
    .update(users)
    .set({
      metadata: sql`${users.metadata} || ${JSON.stringify({ [VOICE_CONSENT_METADATA_KEY]: true })}::jsonb`,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, auth.userId))
    .returning({ metadata: users.metadata });

  if (!updatedUser) {
    throw new Error('Unable to record voice consent for the active user.');
  }

  return (
    normalizeMetadata(updatedUser.metadata)[VOICE_CONSENT_METADATA_KEY] === true
  );
}

export async function updatePersonalPreferencesCommand(
  auth: UserAuthSuccess,
  input: PersonalPreferencesUpdate,
): Promise<PersonalPreferences> {
  const nextMetadataRecord: UserMetadataRecord = {};

  if (input.colorTheme !== undefined) {
    nextMetadataRecord.color_theme = input.colorTheme;
  }

  if (input.mindReaderMode !== undefined) {
    nextMetadataRecord.mind_reader_mode = input.mindReaderMode;
  }

  if (input.narrationMode !== undefined) {
    nextMetadataRecord.narration_mode = input.narrationMode;
  }

  if (input.resultsPageEnabled !== undefined) {
    nextMetadataRecord.results_page_enabled = input.resultsPageEnabled;
  }
  if (input.slackPeerConversationsExperimentEnabled !== undefined) {
    nextMetadataRecord[SLACK_PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY] =
      input.slackPeerConversationsExperimentEnabled;
  }
  if (input.homeComposerSuggestionsEnabled !== undefined) {
    nextMetadataRecord.home_composer_suggestions_enabled =
      input.homeComposerSuggestionsEnabled;
  }
  if (input.sessionSecretToolsEnabled !== undefined) {
    nextMetadataRecord[SESSION_SECRET_TOOLS_EXPERIMENT_KEY] =
      input.sessionSecretToolsEnabled;
  }
  if (input.privateSessionsExperimentEnabled !== undefined) {
    nextMetadataRecord[PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY] =
      input.privateSessionsExperimentEnabled;
  }

  if (Object.keys(nextMetadataRecord).length === 0) {
    return getPersonalPreferencesCommand(auth);
  }

  const [updatedUser] = await db
    .update(users)
    .set({
      metadata: sql`${users.metadata} || ${JSON.stringify(nextMetadataRecord)}::jsonb`,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, auth.userId))
    .returning({ metadata: users.metadata });

  if (!updatedUser) {
    throw new Error('Unable to update preferences for the active user.');
  }

  return normalizePersonalPreferences(normalizeMetadata(updatedUser.metadata));
}

export async function getUserPersonalizationCommand(auth: UserAuthSuccess) {
  const settings = await getUserPersonalization(auth.userId);
  return {
    instructions: settings.instructions,
    learnFromConversations: settings.learnFromConversations,
    version: settings.version,
  };
}

export async function updateUserPersonalizationCommand(
  auth: UserAuthSuccess,
  input: {
    expectedVersion: number;
    instructions?: string;
    learnFromConversations?: boolean;
    reset?: boolean;
  },
) {
  try {
    const settings = await updateUserPersonalization({
      userId: auth.userId,
      ...input,
    });
    return {
      instructions: settings.instructions,
      learnFromConversations: settings.learnFromConversations,
      version: settings.version,
    };
  } catch (error) {
    if (error instanceof UserPersonalizationConflictError) {
      throw new TRPCError({ code: 'CONFLICT', message: error.message });
    }
    throw error;
  }
}
