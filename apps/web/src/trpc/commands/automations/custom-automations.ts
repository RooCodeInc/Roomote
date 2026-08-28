import {
  createCustomAutomation,
  and,
  db,
  deleteCustomAutomation,
  desc,
  eq,
  fastAgentConversations,
  getCustomAutomationById,
  listCustomAutomations,
  inArray,
  updateCustomAutomation,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  listConnectedCommunicationProviders,
  resolveCustomAutomationSchedule,
  resolveDeploymentTimeZone,
  runCustomAutomationNow,
  validateCronExpression,
  type AutomationRunNowResult,
} from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  getCommunicationAutomationTargetKind,
  isScheduleOnlyBackgroundAutomationFrequency,
  resolveAutomationTaskLaunchMode,
  type AutomationTarget,
  type BackgroundAutomationProvider,
  type CustomAutomationScheduleMode,
  type OptionalAutomationTarget,
} from '@roomote/types';
import { captureActivationCustomAutomationChanged } from '@roomote/telemetry/server';
import { toActivationAutomationDestinationProvider } from '@roomote/telemetry';

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
  executionMode: 'sandbox_task' | 'fast';
  launchMode: 'fast_session' | 'legacy_sandbox_task' | 'unavailable';
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
  latestFastResult: string | null;
};

function latestAssistantText(
  messages: Record<string, unknown>[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) =>
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof part.text === 'string'
            ? part.text
            : '',
        )
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

export type CustomAutomationWriteInput = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: string;
  cronExpression?: string | null;
  /** Provider/model launch override, or null for the deployment default. */
  model?: string | null;
  environmentId: string;
  /** Omitted when the automation has no report destination. */
  targetProvider?: 'slack' | 'discord' | 'teams' | 'telegram';
  targetMode?: 'channel' | 'direct_message';
  targetChannelId?: string;
};

function toListItem(
  row: CustomAutomation & {
    createdByUser?: { name: string; email: string } | null;
  },
  latestFastResult: string | null = null,
): CustomAutomationListItem {
  const scheduleMode =
    row.scheduleMode === 'cron'
      ? 'cron'
      : isScheduleOnlyBackgroundAutomationFrequency(row.scheduleMode)
        ? row.scheduleMode
        : 'off';
  const launchMode = resolveAutomationTaskLaunchMode({
    policyId: 'custom_automation',
    runAsUserId: row.createdByUserId,
  });

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode,
    cronExpression: row.cronExpression,
    model: row.model,
    executionMode: row.executionMode,
    launchMode:
      launchMode === 'fast_session'
        ? 'fast_session'
        : row.executionMode === 'sandbox_task'
          ? 'legacy_sandbox_task'
          : 'unavailable',
    environmentId:
      row.executionMode === 'fast'
        ? FAST_EXECUTION
        : row.allRepositories
          ? ALL_REPOSITORIES
          : row.environmentId,
    target: row.target,
    lastRunAt: row.lastRunAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailedAt: row.lastFailedAt,
    lastError: row.lastError,
    lastLaunchedTaskId: row.lastLaunchedTaskId,
    createdByName: row.createdByUser?.name || row.createdByUser?.email || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestFastResult,
  };
}

function buildTarget(
  input: CustomAutomationWriteInput,
  ownerUserId: string,
): OptionalAutomationTarget {
  if (!input.targetProvider) {
    return {};
  }
  const directMessage = input.targetMode === 'direct_message';
  const externalRef = directMessage
    ? ownerUserId
    : (input.targetChannelId?.trim() ?? '');
  if (!externalRef) {
    throw new Error(
      'Choose a destination channel for the selected provider, or set the destination to None.',
    );
  }

  const provider = input.targetProvider as BackgroundAutomationProvider;
  const target: AutomationTarget = {
    provider,
    targetKind: getCommunicationAutomationTargetKind(
      input.targetProvider,
      directMessage ? 'direct_message' : 'channel',
    ),
    externalRef,
  };

  return target;
}

function assertScheduleMode(
  value: string,
): asserts value is CustomAutomationScheduleMode {
  if (!isScheduleOnlyBackgroundAutomationFrequency(value)) {
    if (value === 'cron') return;
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
  const automationIds = rows.map((row) => row.id);
  const conversations = automationIds.length
    ? await db
        .selectDistinctOn([fastAgentConversations.workspaceId], {
          workspaceId: fastAgentConversations.workspaceId,
          compatibilityMessages: fastAgentConversations.compatibilityMessages,
        })
        .from(fastAgentConversations)
        .where(
          and(
            eq(fastAgentConversations.surface, 'automation'),
            inArray(fastAgentConversations.workspaceId, automationIds),
          ),
        )
        .orderBy(
          fastAgentConversations.workspaceId,
          desc(fastAgentConversations.createdAt),
        )
    : [];
  const latestByAutomation = new Map<string, string | null>();
  for (const conversation of conversations) {
    if (latestByAutomation.has(conversation.workspaceId)) continue;
    latestByAutomation.set(
      conversation.workspaceId,
      latestAssistantText(conversation.compatibilityMessages),
    );
  }
  return rows.map((row) =>
    toListItem(row, latestByAutomation.get(row.id) ?? null),
  );
}

export async function createCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput,
): Promise<CustomAutomationListItem> {
  assertAdmin(auth);
  assertScheduleMode(input.scheduleMode);
  const cronExpression =
    input.scheduleMode === 'cron'
      ? validateCronExpression(
          input.cronExpression ?? '',
          (await resolveDeploymentTimeZone()).timeZone,
        )
      : null;
  if (input.targetProvider) {
    await assertDestinationConnected(input.targetProvider);
  }

  const created = await createCustomAutomation({
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    cronExpression,
    model: input.model ?? null,
    environmentId: input.environmentId,
    target: buildTarget(input, auth.userId),
    createdByUserId: auth.userId,
  });

  void captureActivationCustomAutomationChanged(
    'created',
    input.targetProvider ?? null,
  );

  return toListItem(created);
}

export async function updateCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput & { id: string },
): Promise<CustomAutomationListItem> {
  assertAdmin(auth);
  assertScheduleMode(input.scheduleMode);
  const cronExpression =
    input.scheduleMode === 'cron'
      ? validateCronExpression(
          input.cronExpression ?? '',
          (await resolveDeploymentTimeZone()).timeZone,
        )
      : null;
  if (input.targetProvider) {
    await assertDestinationConnected(input.targetProvider);
  }

  const existing = await getCustomAutomationById(input.id);
  if (!existing) {
    throw new Error('Custom automation was not found.');
  }

  const updated = await updateCustomAutomation(input.id, {
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    cronExpression,
    model: input.model ?? null,
    environmentId: input.environmentId,
    target: buildTarget(input, existing.createdByUserId ?? auth.userId),
    createdByUserId: existing.createdByUserId ?? auth.userId,
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
  void captureActivationCustomAutomationChanged(
    'deleted',
    toActivationAutomationDestinationProvider(existing.target.provider),
  );
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
