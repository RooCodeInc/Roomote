import {
  countCustomAutomations,
  createCustomAutomation,
  db,
  environments,
  eq,
  getCustomAutomationById,
  updateCustomAutomation,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  CUSTOM_AUTOMATION_MODEL_MAX_LENGTH,
  CUSTOM_AUTOMATION_NAME_MAX_LENGTH,
  CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH,
  MAX_CUSTOM_AUTOMATIONS,
  isConfiguredAutomationTarget,
  isScheduleOnlyBackgroundAutomationFrequency,
  resolveEvalHarnessSelection,
  type AutomationTarget,
  type BackgroundAutomationTargetKind,
  type CustomAutomationScheduleMode,
  type OptionalAutomationTarget,
} from '@roomote/types';

import {
  customAutomationValidationError,
  CustomAutomationWriteError,
  DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE,
} from './custom-automation-errors';
import {
  resolveCustomAutomationSchedule,
  resolveDeploymentTimeZone,
  validateCronExpression,
  type CustomAutomationScheduleResolution,
} from './custom-automation-schedule';
import { listConnectedCommunicationProviders } from './destination';

export type CustomAutomationResolvedScheduleInput = {
  scheduleMode: string;
  cronExpression?: string | null;
};

export type CustomAutomationScheduleTextInput = {
  schedule: string;
  userId?: string | null;
};

export type CustomAutomationWriteScheduleInput =
  | CustomAutomationResolvedScheduleInput
  | CustomAutomationScheduleTextInput;

export type CustomAutomationTargetWriteInput = {
  provider?: 'slack' | 'discord' | 'teams' | 'telegram';
  channelId?: string;
  serviceUrl?: string | null;
};

type CustomAutomationWriteFields = {
  name: string;
  prompt: string;
  enabled: boolean;
  model?: string | null;
  environmentId: string;
  schedule: CustomAutomationWriteScheduleInput;
  target?: CustomAutomationTargetWriteInput | null;
};

export type CreateCustomAutomationWriteInput = CustomAutomationWriteFields & {
  createdByUserId?: string | null;
};

export type UpdateCustomAutomationWriteInput = Partial<
  Omit<CustomAutomationWriteFields, 'schedule'>
> & {
  schedule?: CustomAutomationWriteScheduleInput;
};

export type CustomAutomationWriteResult =
  | {
      status: 'saved';
      automation: CustomAutomation;
      resolution: CustomAutomationScheduleResolution | null;
    }
  | {
      status: 'ambiguous';
      clarification: string | null;
      resolution: CustomAutomationScheduleResolution;
    };

const TARGET_KIND_BY_PROVIDER: Record<
  CustomAutomationTargetWriteInput['provider'] & string,
  BackgroundAutomationTargetKind
> = {
  slack: 'slack_channel',
  discord: 'discord_channel',
  teams: 'teams_channel',
  telegram: 'telegram_chat',
};

const UNIQUE_VIOLATION_CODE = '23505';
const NAME_UNIQUE_INDEX = 'custom_automations_name_unique_idx';
const SCHEDULE_TEXT_MAX_LENGTH = 500;
const TARGET_CHANNEL_MAX_LENGTH = 160;
const TARGET_SERVICE_URL_MAX_LENGTH = 500;

function validationError(message: string): CustomAutomationWriteError {
  return customAutomationValidationError(message);
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw validationError('Name is required.');
  if (name.length > CUSTOM_AUTOMATION_NAME_MAX_LENGTH) {
    throw validationError(
      `Name must be at most ${CUSTOM_AUTOMATION_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) throw validationError('Prompt is required.');
  if (prompt.length > CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH) {
    throw validationError(
      `Prompt must be at most ${CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH} characters.`,
    );
  }
  return prompt;
}

function normalizeModel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const model = value.trim();
  if (!model) throw validationError('Model must use provider/model format.');
  if (model.length > CUSTOM_AUTOMATION_MODEL_MAX_LENGTH) {
    throw validationError(
      `Model must be at most ${CUSTOM_AUTOMATION_MODEL_MAX_LENGTH} characters.`,
    );
  }
  if (!resolveEvalHarnessSelection({ model }).ok) {
    throw validationError('Model must use provider/model format.');
  }
  return model;
}

async function resolveWriteSchedule(
  input: CustomAutomationWriteScheduleInput,
): Promise<
  | {
      status: 'resolved';
      scheduleMode: CustomAutomationScheduleMode;
      cronExpression: string | null;
      resolution: CustomAutomationScheduleResolution | null;
    }
  | {
      status: 'ambiguous';
      clarification: string | null;
      resolution: CustomAutomationScheduleResolution;
    }
> {
  if ('schedule' in input) {
    const schedule = input.schedule.trim();
    if (!schedule) throw validationError('Schedule is required.');
    if (schedule.length > SCHEDULE_TEXT_MAX_LENGTH) {
      throw validationError(
        `Schedule must be at most ${SCHEDULE_TEXT_MAX_LENGTH} characters.`,
      );
    }
    if (isScheduleOnlyBackgroundAutomationFrequency(schedule)) {
      return {
        status: 'resolved',
        scheduleMode: schedule,
        cronExpression: null,
        resolution: null,
      };
    }

    const resolution = await resolveCustomAutomationSchedule({
      schedule,
      userId: input.userId,
    });
    if (resolution.status === 'ambiguous' || !resolution.cronExpression) {
      return {
        status: 'ambiguous',
        clarification: resolution.clarification,
        resolution,
      };
    }
    return {
      status: 'resolved',
      scheduleMode: 'cron',
      cronExpression: resolution.cronExpression,
      resolution,
    };
  }

  if (
    input.scheduleMode !== 'cron' &&
    !isScheduleOnlyBackgroundAutomationFrequency(input.scheduleMode)
  ) {
    throw validationError(`Invalid schedule mode: ${input.scheduleMode}`);
  }
  if (input.scheduleMode !== 'cron') {
    if (input.cronExpression?.trim()) {
      throw validationError(
        'Cron expression is only valid for a cron schedule.',
      );
    }
    return {
      status: 'resolved',
      scheduleMode: input.scheduleMode,
      cronExpression: null,
      resolution: null,
    };
  }

  if (!input.cronExpression?.trim()) {
    throw validationError('Cron expression is required for a cron schedule.');
  }
  const { timeZone } = await resolveDeploymentTimeZone();
  return {
    status: 'resolved',
    scheduleMode: 'cron',
    cronExpression: validateCronExpression(input.cronExpression, timeZone),
    resolution: null,
  };
}

async function buildTarget(
  input: CustomAutomationTargetWriteInput | null | undefined,
  existing: OptionalAutomationTarget,
): Promise<OptionalAutomationTarget> {
  if (input === undefined) return existing;
  if (input === null) return {};

  const existingTarget = isConfiguredAutomationTarget(existing)
    ? existing
    : null;
  const existingProvider = existingTarget?.provider;
  const provider =
    input.provider ??
    (existingProvider && existingProvider in TARGET_KIND_BY_PROVIDER
      ? (existingProvider as keyof typeof TARGET_KIND_BY_PROVIDER)
      : undefined);
  const channelId =
    input.channelId === undefined
      ? existingTarget?.externalRef
      : input.channelId.trim();
  if (!provider || !(provider in TARGET_KIND_BY_PROVIDER)) {
    throw validationError('Choose a report destination provider.');
  }
  if (!channelId) {
    throw validationError(
      'Choose a destination channel for the selected provider, or set the destination to None.',
    );
  }
  if (channelId.length > TARGET_CHANNEL_MAX_LENGTH) {
    throw validationError(
      `Destination channel must be at most ${TARGET_CHANNEL_MAX_LENGTH} characters.`,
    );
  }

  const connected = await listConnectedCommunicationProviders();
  if (!connected.includes(provider)) {
    throw validationError(
      `Connect ${provider} before saving a ${provider} report destination.`,
    );
  }

  const existingServiceUrl =
    typeof existingTarget?.metadata?.serviceUrl === 'string'
      ? existingTarget.metadata.serviceUrl
      : undefined;
  const serviceUrl =
    input.serviceUrl === null
      ? undefined
      : input.serviceUrl === undefined
        ? existingServiceUrl
        : input.serviceUrl.trim();
  if (
    input.serviceUrl !== undefined &&
    input.serviceUrl !== null &&
    !serviceUrl
  ) {
    throw validationError('Destination service URL cannot be empty.');
  }
  if (serviceUrl && serviceUrl.length > TARGET_SERVICE_URL_MAX_LENGTH) {
    throw validationError(
      `Destination service URL must be at most ${TARGET_SERVICE_URL_MAX_LENGTH} characters.`,
    );
  }
  return {
    provider,
    targetKind: TARGET_KIND_BY_PROVIDER[provider],
    externalRef: channelId,
    ...(serviceUrl ? { metadata: { serviceUrl } } : {}),
  } satisfies AutomationTarget;
}

async function assertEnvironmentExists(environmentId: string): Promise<void> {
  if (!environmentId) throw validationError('Environment is required.');
  const environment = await db.query.environments.findFirst({
    columns: { id: true },
    where: eq(environments.id, environmentId),
  });
  if (!environment) {
    throw new CustomAutomationWriteError(
      'environment_not_found',
      'Selected environment was not found.',
    );
  }
}

function isDuplicateNameViolation(error: unknown): boolean {
  let sawUniqueViolationCode = false;
  let sawNameUniqueIndex = false;
  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 10;
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    sawUniqueViolationCode ||= candidate.code === UNIQUE_VIOLATION_CODE;
    sawNameUniqueIndex ||=
      candidate.constraint === NAME_UNIQUE_INDEX ||
      (typeof candidate.message === 'string' &&
        candidate.message.includes(NAME_UNIQUE_INDEX));
    if (sawUniqueViolationCode && sawNameUniqueIndex) return true;
    current = candidate.cause;
  }
  return false;
}

async function persist<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateNameViolation(error)) {
      throw new CustomAutomationWriteError(
        'duplicate_name',
        DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function createCustomAutomationWrite(
  input: CreateCustomAutomationWriteInput,
): Promise<CustomAutomationWriteResult> {
  const name = normalizeName(input.name);
  const prompt = normalizePrompt(input.prompt);
  const model = normalizeModel(input.model);
  const schedule = await resolveWriteSchedule(input.schedule);
  if (schedule.status === 'ambiguous') return schedule;
  const target = await buildTarget(input.target ?? null, {});
  await assertEnvironmentExists(input.environmentId);
  if ((await countCustomAutomations()) >= MAX_CUSTOM_AUTOMATIONS) {
    throw new CustomAutomationWriteError(
      'limit_reached',
      `You can create at most ${MAX_CUSTOM_AUTOMATIONS} custom automations.`,
    );
  }

  const automation = await persist(() =>
    createCustomAutomation({
      name,
      prompt,
      enabled: input.enabled,
      scheduleMode: schedule.scheduleMode,
      cronExpression: schedule.cronExpression,
      model,
      environmentId: input.environmentId,
      target,
      createdByUserId: input.createdByUserId ?? null,
    }),
  );
  return { status: 'saved', automation, resolution: schedule.resolution };
}

export async function updateCustomAutomationWrite(
  id: string,
  input: UpdateCustomAutomationWriteInput,
): Promise<CustomAutomationWriteResult> {
  const existing = await getCustomAutomationById(id);
  if (!existing) {
    throw new CustomAutomationWriteError(
      'not_found',
      'Custom automation was not found.',
    );
  }

  const schedule = input.schedule
    ? await resolveWriteSchedule(input.schedule)
    : {
        status: 'resolved' as const,
        scheduleMode: existing.scheduleMode as CustomAutomationScheduleMode,
        cronExpression: existing.cronExpression,
        resolution: null,
      };
  if (schedule.status === 'ambiguous') return schedule;

  const environmentId = input.environmentId ?? existing.environmentId ?? '';
  const target = await buildTarget(input.target, existing.target);
  await assertEnvironmentExists(environmentId);
  const automation = await persist(() =>
    updateCustomAutomation(id, {
      name: normalizeName(input.name ?? existing.name),
      prompt: normalizePrompt(input.prompt ?? existing.prompt),
      enabled: input.enabled ?? existing.enabled,
      scheduleMode: schedule.scheduleMode,
      cronExpression: schedule.cronExpression,
      model:
        input.model === undefined
          ? existing.model
          : normalizeModel(input.model),
      environmentId,
      target,
    }),
  );
  if (!automation) {
    throw new CustomAutomationWriteError(
      'not_found',
      'Custom automation was not found.',
    );
  }
  return { status: 'saved', automation, resolution: schedule.resolution };
}
