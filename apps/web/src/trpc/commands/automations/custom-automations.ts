import {
  deleteCustomAutomation,
  getCustomAutomationById,
  listCustomAutomations,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  createCustomAutomationWrite,
  resolveCustomAutomationSchedule,
  runCustomAutomationNow,
  updateCustomAutomationWrite,
  type AutomationRunNowResult,
} from '@roomote/sdk/server';
import {
  isScheduleOnlyBackgroundAutomationFrequency,
  type CustomAutomationScheduleMode,
  type OptionalAutomationTarget,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from './feature-gates';

export type CustomAutomationListItem = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: CustomAutomationScheduleMode;
  cronExpression: string | null;
  model: string | null;
  environmentId: string | null;
  target: OptionalAutomationTarget;
  lastRunAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
  lastLaunchedTaskId: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomAutomationWriteInput = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: string;
  cronExpression?: string | null;
  /** Provider/model launch override, or null for the deployment default. */
  model?: string | null;
  environmentId: string;
  /** Omitted when the automation has no report destination channel. */
  targetProvider?: 'slack' | 'discord' | 'teams' | 'telegram';
  targetChannelId?: string;
  targetServiceUrl?: string | null;
};

function toListItem(
  row: CustomAutomation & {
    createdByUser?: { name: string; email: string } | null;
  },
): CustomAutomationListItem {
  const scheduleMode =
    row.scheduleMode === 'cron'
      ? 'cron'
      : isScheduleOnlyBackgroundAutomationFrequency(row.scheduleMode)
        ? row.scheduleMode
        : 'off';

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode,
    cronExpression: row.cronExpression,
    model: row.model,
    environmentId: row.environmentId,
    target: row.target,
    lastRunAt: row.lastRunAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailedAt: row.lastFailedAt,
    lastError: row.lastError,
    lastLaunchedTaskId: row.lastLaunchedTaskId,
    createdByName: row.createdByUser?.name || row.createdByUser?.email || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listCustomAutomationsCommand(
  auth: UserAuthSuccess,
): Promise<CustomAutomationListItem[]> {
  assertAdmin(auth);
  const rows = await listCustomAutomations();
  return rows.map(toListItem);
}

export async function createCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput,
): Promise<CustomAutomationListItem> {
  assertAdmin(auth);
  const result = await createCustomAutomationWrite({
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    model: input.model ?? null,
    environmentId: input.environmentId,
    schedule: {
      scheduleMode: input.scheduleMode,
      cronExpression: input.cronExpression,
    },
    target: input.targetProvider
      ? {
          provider: input.targetProvider,
          channelId: input.targetChannelId,
          serviceUrl: input.targetServiceUrl,
        }
      : null,
    createdByUserId: auth.userId,
  });
  if (result.status === 'ambiguous') {
    throw new Error(result.clarification ?? 'Schedule needs clarification.');
  }
  return toListItem(result.automation);
}

export async function updateCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput & { id: string },
): Promise<CustomAutomationListItem> {
  assertAdmin(auth);
  const result = await updateCustomAutomationWrite(input.id, {
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    model: input.model ?? null,
    environmentId: input.environmentId,
    schedule: {
      scheduleMode: input.scheduleMode,
      cronExpression: input.cronExpression,
    },
    target: input.targetProvider
      ? {
          provider: input.targetProvider,
          channelId: input.targetChannelId,
          serviceUrl: input.targetServiceUrl,
        }
      : null,
  });
  if (result.status === 'ambiguous') {
    throw new Error(result.clarification ?? 'Schedule needs clarification.');
  }
  return toListItem(result.automation);
}

export async function deleteCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<{ success: true }> {
  assertAdmin(auth);

  const existing = await getCustomAutomationById(input.id);
  if (!existing) {
    throw new Error('Custom automation was not found.');
  }

  await deleteCustomAutomation(input.id);
  return { success: true };
}

export async function triggerCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<AutomationRunNowResult> {
  assertAdmin(auth);
  return runCustomAutomationNow(input.id);
}

export async function resolveCustomAutomationScheduleCommand(
  auth: UserAuthSuccess,
  input: { schedule: string },
) {
  assertAdmin(auth);
  return resolveCustomAutomationSchedule({
    schedule: input.schedule,
    userId: auth.userId,
  });
}
