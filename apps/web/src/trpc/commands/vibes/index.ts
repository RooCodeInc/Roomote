import {
  db,
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
  deploymentSettings,
  getBackgroundAgentSettingsForDeployment,
  normalizeOptionalSlackEmojiName,
} from '@roomote/db/server';
import {
  STYLE_GUIDANCE_GENERIC_ERROR_MESSAGE,
  ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH,
} from '@roomote/cloud-agents/style-guidance-constants';
import { validateStyleGuidance } from '@roomote/cloud-agents/server';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getVibesSettingsCommand(auth: UserAuthSuccess): Promise<{
  slackSummonEmoji: string | null;
  slackAckEmoji: string;
  slackCompletionEmoji: string;
  styleGuidance: string | null;
  defaults: {
    slackAckEmoji: string;
    slackCompletionEmoji: string;
  };
}> {
  assertAdmin(auth);

  const settings = await getBackgroundAgentSettingsForDeployment();

  return {
    slackSummonEmoji: settings.slackSummonEmoji,
    slackAckEmoji: settings.slackAckEmoji,
    slackCompletionEmoji: settings.slackCompletionEmoji,
    styleGuidance: settings.styleGuidance,
    defaults: {
      slackAckEmoji: DEFAULT_SLACK_ACK_EMOJI,
      slackCompletionEmoji: DEFAULT_SLACK_COMPLETION_EMOJI,
    },
  };
}

interface UpdateVibesSettingsInput {
  slackSummonEmoji?: string | null;
  slackAckEmoji?: string;
  slackCompletionEmoji?: string;
  styleGuidance?: string | null;
}

export async function updateVibesSettingsCommand(
  auth: UserAuthSuccess,
  input: UpdateVibesSettingsInput,
): Promise<
  | {
      success: true;
      settings: Awaited<ReturnType<typeof getVibesSettingsCommand>>;
    }
  | {
      success: false;
      fieldErrors: {
        slackSummonEmoji?: string;
        slackAckEmoji?: string;
        slackCompletionEmoji?: string;
        styleGuidance?: string;
      };
    }
> {
  assertAdmin(auth);

  const fieldErrors: {
    slackSummonEmoji?: string;
    slackAckEmoji?: string;
    slackCompletionEmoji?: string;
    styleGuidance?: string;
  } = {};
  const now = new Date();
  const updates: Record<string, string | Date | null> = {};

  if (Object.prototype.hasOwnProperty.call(input, 'slackSummonEmoji')) {
    updates.slackSummonEmoji = normalizeOptionalSlackEmojiName(
      input.slackSummonEmoji,
    );
  }

  if (Object.prototype.hasOwnProperty.call(input, 'slackAckEmoji')) {
    const normalizedAckEmoji = normalizeOptionalSlackEmojiName(
      input.slackAckEmoji,
    );

    if (!normalizedAckEmoji) {
      fieldErrors.slackAckEmoji = 'Acknowledgement emoji is required.';
    } else {
      updates.slackAckEmoji = normalizedAckEmoji;
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'slackCompletionEmoji')) {
    const normalizedCompletionEmoji = normalizeOptionalSlackEmojiName(
      input.slackCompletionEmoji,
    );

    if (!normalizedCompletionEmoji) {
      fieldErrors.slackCompletionEmoji = 'Completion emoji is required.';
    } else {
      updates.slackCompletionEmoji = normalizedCompletionEmoji;
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'styleGuidance')) {
    if (
      (input.styleGuidance?.length ?? 0) > ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH
    ) {
      fieldErrors.styleGuidance = STYLE_GUIDANCE_GENERIC_ERROR_MESSAGE;
    } else {
      const styleGuidance = input.styleGuidance?.trim() || null;

      if (!styleGuidance) {
        updates.styleGuidance = null;
      } else {
        try {
          const result = await validateStyleGuidance({
            styleGuidance,
            userId: auth.userId,
          });

          if (!result.isToneOnly) {
            fieldErrors.styleGuidance = STYLE_GUIDANCE_GENERIC_ERROR_MESSAGE;
          } else {
            updates.styleGuidance = styleGuidance;
          }
        } catch {
          fieldErrors.styleGuidance = STYLE_GUIDANCE_GENERIC_ERROR_MESSAGE;
        }
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      fieldErrors,
    };
  }

  if (Object.keys(updates).length === 0) {
    return {
      success: true,
      settings: await getVibesSettingsCommand(auth),
    };
  }

  await db
    .insert(deploymentSettings)
    .values({
      id: 'default',
      ...updates,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        ...updates,
        updatedAt: now,
      },
    });

  return {
    success: true,
    settings: await getVibesSettingsCommand(auth),
  };
}
