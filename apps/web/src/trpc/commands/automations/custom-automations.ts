import {
  createCustomAutomation,
  deleteCustomAutomation,
  getCustomAutomationById,
  listCustomAutomations,
  updateCustomAutomation,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  listConnectedCommunicationProviders,
  runCustomAutomationNow,
  type AutomationRunNowResult,
} from '@roomote/sdk/server';
import {
  isScheduleOnlyBackgroundAutomationFrequency,
  type AutomationTarget,
  type BackgroundAutomationProvider,
  type BackgroundAutomationTargetKind,
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
  environmentId: string | null;
  target: OptionalAutomationTarget;
  lastRunAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
  lastLaunchedTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomAutomationWriteInput = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: string;
  environmentId: string;
  /** Omitted when the automation has no report destination channel. */
  targetProvider?: 'slack' | 'discord' | 'teams' | 'telegram';
  targetChannelId?: string;
  targetServiceUrl?: string | null;
};

function toListItem(row: CustomAutomation): CustomAutomationListItem {
  const scheduleMode = isScheduleOnlyBackgroundAutomationFrequency(
    row.scheduleMode,
  )
    ? row.scheduleMode
    : 'off';

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode,
    environmentId: row.environmentId,
    target: row.target,
    lastRunAt: row.lastRunAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailedAt: row.lastFailedAt,
    lastError: row.lastError,
    lastLaunchedTaskId: row.lastLaunchedTaskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildTarget(
  input: CustomAutomationWriteInput,
): OptionalAutomationTarget {
  if (!input.targetProvider) {
    return {};
  }

  const externalRef = input.targetChannelId?.trim() ?? '';
  if (!externalRef) {
    throw new Error(
      'Choose a destination channel for the selected provider, or set the destination to None.',
    );
  }

  const targetKindByProvider: Record<
    NonNullable<CustomAutomationWriteInput['targetProvider']>,
    BackgroundAutomationTargetKind
  > = {
    slack: 'slack_channel',
    discord: 'discord_channel',
    teams: 'teams_channel',
    telegram: 'telegram_chat',
  };

  const provider = input.targetProvider as BackgroundAutomationProvider;
  const target: AutomationTarget = {
    provider,
    targetKind: targetKindByProvider[input.targetProvider],
    externalRef,
  };

  const serviceUrl = input.targetServiceUrl?.trim();
  if (serviceUrl) {
    target.metadata = { serviceUrl };
  }

  return target;
}

function assertScheduleMode(
  value: string,
): asserts value is CustomAutomationScheduleMode {
  if (!isScheduleOnlyBackgroundAutomationFrequency(value)) {
    throw new Error(`Invalid schedule mode: ${value}`);
  }
}

async function assertDestinationConnected(
  provider: NonNullable<CustomAutomationWriteInput['targetProvider']>,
): Promise<void> {
  const connected = await listConnectedCommunicationProviders();
  if (!connected.includes(provider)) {
    throw new Error(
      `Connect ${provider} before saving a ${provider} report destination.`,
    );
  }
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
  assertScheduleMode(input.scheduleMode);
  if (input.targetProvider) {
    await assertDestinationConnected(input.targetProvider);
  }

  const created = await createCustomAutomation({
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    environmentId: input.environmentId,
    target: buildTarget(input),
    createdByUserId: auth.userId,
  });

  return toListItem(created);
}

export async function updateCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput & { id: string },
): Promise<CustomAutomationListItem> {
  assertAdmin(auth);
  assertScheduleMode(input.scheduleMode);
  if (input.targetProvider) {
    await assertDestinationConnected(input.targetProvider);
  }

  const updated = await updateCustomAutomation(input.id, {
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    environmentId: input.environmentId,
    target: buildTarget(input),
  });

  return toListItem(updated);
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
