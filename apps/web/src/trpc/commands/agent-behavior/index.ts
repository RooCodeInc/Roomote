import {
  db,
  deploymentSettings,
  getBackgroundAgentSettingsForDeployment,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

export async function getAgentBehaviorSettingsCommand(
  auth: UserAuthSuccess,
): Promise<{
  globalAgentInstructions: string | null;
}> {
  assertAdmin(auth);

  const settings = await getBackgroundAgentSettingsForDeployment();

  return {
    globalAgentInstructions: settings.globalAgentInstructions ?? null,
  };
}

export async function updateAgentBehaviorSettingsCommand(
  auth: UserAuthSuccess,
  input: {
    globalAgentInstructions?: string | null;
  },
): Promise<
  | {
      success: true;
      settings: {
        globalAgentInstructions: string | null;
      };
    }
  | {
      success: false;
      fieldErrors: {
        globalAgentInstructions?: string;
      };
    }
> {
  assertAdmin(auth);

  if ((input.globalAgentInstructions?.length ?? 0) > 10_000) {
    return {
      success: false,
      fieldErrors: {
        globalAgentInstructions: 'Global agent instructions are too long.',
      },
    };
  }

  const existingSettings = await getBackgroundAgentSettingsForDeployment();
  const globalAgentInstructions =
    input.globalAgentInstructions === undefined
      ? (existingSettings.globalAgentInstructions ?? null)
      : normalizeOptionalText(input.globalAgentInstructions);
  const now = new Date();

  await db
    .insert(deploymentSettings)
    .values({
      id: 'default',
      globalAgentInstructions,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        globalAgentInstructions,
        updatedAt: now,
      },
    });

  return {
    success: true,
    settings: {
      globalAgentInstructions,
    },
  };
}
