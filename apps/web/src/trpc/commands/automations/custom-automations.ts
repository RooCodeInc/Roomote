import {
  createCustomAutomation,
  and,
  db,
  deleteCustomAutomation,
  desc,
  eq,
  fastAgentConversations,
  getDeploymentTaskModelOptions,
  getBackgroundAgentSettingsForDeployment,
  getCustomAutomationById,
  listCustomAutomations,
  inArray,
  updateCustomAutomation,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  listConnectedCommunicationProviders,
  listAvailableAgentMailOutboundIdentities,
  getCustomAutomationNextRunAt,
  resolveCustomAutomationSchedule,
  resolveDeploymentTimeZone,
  runCustomAutomationNow,
  canStartAgentMailConversationWithUser,
  validateCronExpression,
  type AutomationRunNowResult,
} from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  AUTOMATION_TARGET_EMAIL_IDENTITY_KEY,
  FAST_EXECUTION,
  NO_REPOSITORIES,
  getAutomationTargetEmailIdentityId,
  getAutomationTargetKind,
  isScheduleOnlyBackgroundAutomationFrequency,
  type AutomationTarget,
  type BackgroundAutomationProvider,
  type CustomAutomationScheduleMode,
  type OptionalAutomationTarget,
  type ReasoningEffort,
} from '@roomote/types';
import { captureActivationCustomAutomationChanged } from '@roomote/telemetry/server';
import { toActivationAutomationDestinationProvider } from '@roomote/telemetry';

import type { UserAuthSuccess } from '@/types';

async function getOwnedAutomation(auth: UserAuthSuccess, id: string) {
  const automation = await getCustomAutomationById(id);
  if (
    !automation ||
    (!auth.isAdmin && automation.createdByUserId !== auth.userId)
  ) {
    throw new Error('Custom automation was not found.');
  }
  return automation;
}

export type CustomAutomationListItem = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: CustomAutomationScheduleMode;
  cronExpression: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  executionMode: 'sandbox_task' | 'fast';
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
  nextRunAt: Date | null;
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
  /** Reasoning override for the selected model, or null for its default. */
  reasoningEffort?: ReasoningEffort | null;
  environmentId: string;
  /** Omitted when the automation has no report destination. */
  targetProvider?: 'slack' | 'discord' | 'teams' | 'telegram' | 'email';
  targetMode?: 'channel' | 'direct_message';
  targetChannelId?: string;
};

function toListItem(
  row: CustomAutomation & {
    createdByUser?: { name: string; email: string } | null;
  },
  latestFastResult: string | null = null,
  scheduleContext?: Awaited<ReturnType<typeof resolveDeploymentTimeZone>>,
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
    reasoningEffort: row.reasoningEffort,
    executionMode: row.executionMode,
    environmentId:
      row.executionMode === 'fast'
        ? FAST_EXECUTION
        : row.allRepositories
          ? ALL_REPOSITORIES
          : row.noRepositories
            ? NO_REPOSITORIES
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
    nextRunAt: scheduleContext
      ? getCustomAutomationNextRunAt({
          enabled: row.enabled,
          scheduleMode,
          cronExpression: row.cronExpression,
          timeZone: scheduleContext.timeZone,
          timeZoneUpdatedAt: scheduleContext.updatedAt,
          lastRunAt: row.lastRunAt,
          createdAt: row.createdAt,
        })
      : null,
  };
}

function buildTarget(
  input: CustomAutomationWriteInput,
  ownerUserId: string,
): OptionalAutomationTarget {
  if (!input.targetProvider) {
    return {};
  }
  if (input.targetProvider === 'email') {
    if (input.targetMode === 'channel') {
      throw new Error('Email destinations must use direct message mode.');
    }
    const identityId = input.targetChannelId?.trim();
    if (!identityId) {
      throw new Error('Choose a verified Email identity.');
    }
    // Email keeps the direct-message shape (externalRef = owner) and pins the
    // selected identity in metadata.
    return {
      provider: 'email',
      targetKind: getAutomationTargetKind('email', 'direct_message'),
      externalRef: ownerUserId,
      metadata: { [AUTOMATION_TARGET_EMAIL_IDENTITY_KEY]: identityId },
    };
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
    targetKind: getAutomationTargetKind(
      input.targetProvider,
      directMessage ? 'direct_message' : 'channel',
    ),
    externalRef,
  };

  return target;
}

function isSameDestination(
  left: OptionalAutomationTarget,
  right: OptionalAutomationTarget,
): boolean {
  return (
    left.provider === right.provider &&
    left.targetKind === right.targetKind &&
    left.externalRef === right.externalRef &&
    getAutomationTargetEmailIdentityId(left) ===
      getAutomationTargetEmailIdentityId(right)
  );
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
  ownerUserId: string,
  emailIdentityId?: string,
): Promise<void> {
  if (provider === 'email') {
    if (
      !emailIdentityId ||
      !(await canStartAgentMailConversationWithUser(
        ownerUserId,
        emailIdentityId,
      ))
    ) {
      throw new Error(
        'Verify your Email address and ask an admin to configure AgentMail before saving this destination.',
      );
    }
    return;
  }
  const connected = await listConnectedCommunicationProviders();
  if (!connected.includes(provider)) {
    throw new Error(
      `Connect ${provider} before saving a ${provider} report destination.`,
    );
  }
}

async function assertAutomationModelSelection(
  model: string | null | undefined,
  reasoningEffort: ReasoningEffort | null | undefined,
): Promise<void> {
  if (!model) {
    if (reasoningEffort) {
      throw new Error('Reasoning effort requires a model override.');
    }
    return;
  }

  const { models } = await getDeploymentTaskModelOptions();
  const option = models.find((candidate) => candidate.id === model);
  if (!option) {
    throw new Error(`Model "${model}" is not enabled for new tasks.`);
  }
  if (reasoningEffort && option.metadata?.supportsReasoning === false) {
    throw new Error(
      `Model "${model}" does not support configurable reasoning effort.`,
    );
  }
}

export async function listCustomAutomationsCommand(
  auth: UserAuthSuccess,
): Promise<CustomAutomationListItem[]> {
  const [allRows, scheduleContext] = await Promise.all([
    listCustomAutomations(),
    resolveDeploymentTimeZone(),
  ]);
  const rows = allRows.filter(
    (row) => auth.isAdmin || row.createdByUserId === auth.userId,
  );
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
    toListItem(row, latestByAutomation.get(row.id) ?? null, scheduleContext),
  );
}

export async function getCustomAutomationOptionsCommand(
  auth: UserAuthSuccess,
  input: { automationId?: string } = {},
) {
  // Email identities belong to the automation owner (runs execute as the
  // creator), so editing someone else's automation lists the owner's
  // identities rather than the viewer's.
  const ownerUserId = input.automationId
    ? ((await getOwnedAutomation(auth, input.automationId)).createdByUserId ??
      auth.userId)
    : auth.userId;
  const [providers, emailIdentities, { timeZone }, settings] =
    await Promise.all([
      listConnectedCommunicationProviders(),
      listAvailableAgentMailOutboundIdentities(ownerUserId),
      resolveDeploymentTimeZone(),
      auth.isAdmin ? getBackgroundAgentSettingsForDeployment() : null,
    ]);

  return {
    capabilities: {
      slackConnected: providers.includes('slack'),
      discordConnected: providers.includes('discord'),
      telegramConnected: providers.includes('telegram'),
      teamsConnected: providers.includes('teams'),
      emailConnected: emailIdentities.length > 0,
    },
    emailIdentities,
    // Channel catalogs are bot-scoped, not evidence of a member's access.
    managerSlackChannelId: settings?.managerSlackChannelId ?? null,
    managerDiscordChannelId: settings?.managerDiscordChannelId ?? null,
    effectiveTimeZone: timeZone,
  };
}

export async function createCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput,
): Promise<CustomAutomationListItem> {
  assertScheduleMode(input.scheduleMode);
  const scheduleContext = await resolveDeploymentTimeZone();
  const cronExpression =
    input.scheduleMode === 'cron'
      ? validateCronExpression(
          input.cronExpression ?? '',
          scheduleContext.timeZone,
        )
      : null;
  if (input.targetProvider) {
    await assertDestinationConnected(
      input.targetProvider,
      auth.userId,
      input.targetChannelId,
    );
  }
  await assertAutomationModelSelection(input.model, input.reasoningEffort);

  const created = await createCustomAutomation({
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    cronExpression,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    environmentId: input.environmentId,
    target: buildTarget(input, auth.userId),
    createdByUserId: auth.userId,
  });

  void captureActivationCustomAutomationChanged(
    'created',
    input.targetProvider ?? null,
  );

  return toListItem(created, null, scheduleContext);
}

export async function updateCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: CustomAutomationWriteInput & { id: string },
): Promise<CustomAutomationListItem> {
  const existing = await getOwnedAutomation(auth, input.id);
  assertScheduleMode(input.scheduleMode);
  const scheduleContext = await resolveDeploymentTimeZone();
  const cronExpression =
    input.scheduleMode === 'cron'
      ? validateCronExpression(
          input.cronExpression ?? '',
          scheduleContext.timeZone,
        )
      : null;
  const ownerUserId = existing.createdByUserId ?? auth.userId;
  const target = buildTarget(input, ownerUserId);
  // The form and the list-row toggle resend the whole record, so a stale
  // destination is re-validated only when the destination actually changes;
  // otherwise disabling or renaming an automation would be blocked.
  if (input.targetProvider && !isSameDestination(target, existing.target)) {
    if (input.targetProvider === 'email' && !existing.createdByUserId) {
      throw new Error('Automation owner is not configured.');
    }
    await assertDestinationConnected(
      input.targetProvider,
      ownerUserId,
      input.targetChannelId,
    );
  }
  await assertAutomationModelSelection(input.model, input.reasoningEffort);

  const updated = await updateCustomAutomation(input.id, {
    name: input.name,
    prompt: input.prompt,
    enabled: input.enabled,
    scheduleMode: input.scheduleMode,
    cronExpression,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    environmentId: input.environmentId,
    target,
  });

  return toListItem(updated, null, scheduleContext);
}

export async function deleteCustomAutomationCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<{ success: true }> {
  const existing = await getOwnedAutomation(auth, input.id);

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
  await getOwnedAutomation(auth, input.id);
  return runCustomAutomationNow(input.id);
}

export async function resolveCustomAutomationScheduleCommand(
  auth: UserAuthSuccess,
  input: { schedule: string },
) {
  return resolveCustomAutomationSchedule({
    schedule: input.schedule,
    userId: auth.userId,
  });
}
