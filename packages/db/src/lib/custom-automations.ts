import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import {
  ALL_REPOSITORIES,
  isConfiguredAutomationTarget,
  isScheduleOnlyBackgroundAutomationFrequency,
  type CustomAutomationScheduleMode,
  type CustomAutomationExecutionMode,
  type OptionalAutomationTarget,
  type ScheduleOnlyBackgroundAutomationFrequency,
  CUSTOM_AUTOMATION_NAME_MAX_LENGTH,
  CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH,
  CUSTOM_AUTOMATION_LAUNCH_CRITERIA_MAX_LENGTH,
  CUSTOM_AUTOMATION_CRON_MAX_LENGTH,
  CUSTOM_AUTOMATION_MODEL_MAX_LENGTH,
  FAST_EXECUTION,
  NO_REPOSITORIES,
  type ReasoningEffort,
  type AutomationResultPriority,
  customAutomationRunWhenSchema,
  type CustomAutomationRunWhen,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { customAutomations, environments, tasks } from '../schema';
import { decryptText } from './encryption';
import type { CustomAutomation } from '../types';
import type { AutomationRunOutcomeStatus } from './automations';

export {
  CUSTOM_AUTOMATION_NAME_MAX_LENGTH,
  CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH,
};

/** Stale launch claims older than this may be reclaimed by a later launcher. */
export const CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS = 10 * 60 * 1000;

export type CustomAutomationWriteInput = {
  name: string;
  prompt: string;
  enabled: boolean;
  resultPriority?: AutomationResultPriority;
  scheduleMode: CustomAutomationScheduleMode;
  cronExpression?: string | null;
  /** Optional provider/model launch override; null uses the deployment default. */
  model?: string | null;
  /** Optional reasoning override for the selected model. */
  reasoningEffort?: ReasoningEffort | null;
  environmentId: string;
  /** Full destination target, or {} when the automation has no report destination. */
  target: OptionalAutomationTarget;
  /** Optional typed criteria evaluated before automation work starts. */
  runWhen?: CustomAutomationRunWhen | null;
  /** Optional natural-language gate evaluated before automation work starts. */
  launchCriteria?: string | null;
  createdByUserId?: string | null;
};

function getExecutionTarget(environmentId: string): {
  executionMode: CustomAutomationExecutionMode;
  allRepositories: boolean;
  noRepositories: boolean;
} {
  return environmentId === FAST_EXECUTION
    ? {
        executionMode: 'fast',
        allRepositories: false,
        noRepositories: false,
      }
    : {
        executionMode: 'sandbox_task',
        allRepositories: environmentId === ALL_REPOSITORIES,
        noRepositories: environmentId === NO_REPOSITORIES,
      };
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function assertValidWriteInput(input: CustomAutomationWriteInput): {
  name: string;
  prompt: string;
  cronExpression: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  launchCriteria?: string | null;
  runWhen?: CustomAutomationRunWhen | null;
} {
  const name = normalizeName(input.name);
  const prompt = input.prompt.trim();
  const launchCriteria =
    input.launchCriteria === undefined
      ? undefined
      : input.launchCriteria?.trim() || null;

  if (!name) {
    throw new Error('Name is required.');
  }

  if (name.length > CUSTOM_AUTOMATION_NAME_MAX_LENGTH) {
    throw new Error(
      `Name must be at most ${CUSTOM_AUTOMATION_NAME_MAX_LENGTH} characters.`,
    );
  }

  if (!prompt) {
    throw new Error('Prompt is required.');
  }

  if (prompt.length > CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH) {
    throw new Error(
      `Prompt must be at most ${CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH} characters.`,
    );
  }

  if (
    launchCriteria &&
    launchCriteria.length > CUSTOM_AUTOMATION_LAUNCH_CRITERIA_MAX_LENGTH
  ) {
    throw new Error(
      `Launch criteria must be at most ${CUSTOM_AUTOMATION_LAUNCH_CRITERIA_MAX_LENGTH} characters.`,
    );
  }

  if (
    input.scheduleMode !== 'cron' &&
    input.scheduleMode !== 'on_demand' &&
    !isScheduleOnlyBackgroundAutomationFrequency(input.scheduleMode)
  ) {
    throw new Error(`Invalid schedule mode: ${input.scheduleMode}`);
  }

  const cronExpression = input.cronExpression?.trim() || null;
  if (input.scheduleMode === 'cron' && !cronExpression) {
    throw new Error('Cron expression is required for a cron schedule.');
  }
  if (input.scheduleMode !== 'cron' && cronExpression) {
    throw new Error('Cron expression is only valid for a cron schedule.');
  }
  if (
    cronExpression &&
    cronExpression.length > CUSTOM_AUTOMATION_CRON_MAX_LENGTH
  ) {
    throw new Error(
      `Cron expression must be at most ${CUSTOM_AUTOMATION_CRON_MAX_LENGTH} characters.`,
    );
  }

  const model = input.model?.trim() || null;
  if (model) {
    if (model.length > CUSTOM_AUTOMATION_MODEL_MAX_LENGTH) {
      throw new Error(
        `Model must be at most ${CUSTOM_AUTOMATION_MODEL_MAX_LENGTH} characters.`,
      );
    }
    if (!/^[^/\s]+\/.+$/u.test(model)) {
      throw new Error('Model must use provider/model format.');
    }
  }

  const reasoningEffort = input.reasoningEffort ?? null;
  if (reasoningEffort && !model) {
    throw new Error('Reasoning effort requires a model override.');
  }

  const runWhen =
    input.runWhen == null
      ? input.runWhen
      : customAutomationRunWhenSchema.parse(input.runWhen);

  if (!input.environmentId) {
    throw new Error('Environment is required.');
  }

  const hasAnyTargetField = Boolean(
    input.target?.provider ||
    input.target?.targetKind ||
    input.target?.externalRef,
  );
  if (hasAnyTargetField && !isConfiguredAutomationTarget(input.target)) {
    throw new Error(
      'Report destination must include a provider, target kind, and reference.',
    );
  }

  return {
    name,
    prompt,
    cronExpression,
    model,
    reasoningEffort,
    launchCriteria,
    runWhen,
  };
}

export type CustomAutomationWithCreator = CustomAutomation & {
  createdByUser: { id: string; name: string; email: string } | null;
};

export async function listCustomAutomations(
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomationWithCreator[]> {
  return client.query.customAutomations.findMany({
    orderBy: [asc(customAutomations.name)],
    with: {
      createdByUser: { columns: { id: true, name: true, email: true } },
    },
  });
}

export async function listEnabledCustomAutomations(
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation[]> {
  return client.query.customAutomations.findMany({
    where: eq(customAutomations.enabled, true),
    orderBy: [asc(customAutomations.createdAt)],
  });
}

export async function getCustomAutomationById(
  id: string,
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation | null> {
  const row = await client.query.customAutomations.findFirst({
    where: eq(customAutomations.id, id),
  });

  return row ?? null;
}

/** Returns the decrypted webhook bearer token for trusted server callers. */
export async function getCustomAutomationWebhookToken(
  id: string,
  client: DatabaseOrTransaction = db,
): Promise<string | null> {
  const row = await client.query.customAutomations.findFirst({
    where: eq(customAutomations.id, id),
    columns: { webhookSecret: true },
  });
  return row?.webhookSecret ? decryptText(row.webhookSecret) : null;
}

export async function getCustomAutomationWebhookState(
  id: string,
  client: DatabaseOrTransaction = db,
): Promise<{
  enabled: boolean;
  createdByUserId: string | null;
  token: string | null;
} | null> {
  const row = await client.query.customAutomations.findFirst({
    where: eq(customAutomations.id, id),
    columns: {
      enabled: true,
      createdByUserId: true,
      webhookSecret: true,
    },
  });
  return row
    ? {
        enabled: row.enabled,
        createdByUserId: row.createdByUserId,
        token: row.webhookSecret ? decryptText(row.webhookSecret) : null,
      }
    : null;
}

/** Stores a new encrypted webhook token or revokes the current one. */
export async function setCustomAutomationWebhookToken(
  id: string,
  token: string | null,
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const updated = await client
    .update(customAutomations)
    .set({ webhookSecret: token, updatedAt: new Date() })
    .where(eq(customAutomations.id, id))
    .returning({ id: customAutomations.id });
  return updated.length > 0;
}

/**
 * Ensures one encrypted webhook token exists despite concurrent enable calls.
 * Returns the persisted token (including another request's winning token).
 */
export async function ensureCustomAutomationWebhookToken(
  id: string,
  token: string,
  client: DatabaseOrTransaction = db,
): Promise<string | null> {
  const inserted = await client
    .update(customAutomations)
    .set({ webhookSecret: token, updatedAt: new Date() })
    .where(
      and(
        eq(customAutomations.id, id),
        eq(customAutomations.enabled, true),
        isNull(customAutomations.webhookSecret),
      ),
    )
    .returning({ webhookSecret: customAutomations.webhookSecret });
  if (inserted[0]?.webhookSecret) {
    return decryptText(inserted[0].webhookSecret);
  }
  const current = await getCustomAutomationWebhookState(id, client);
  return current?.enabled ? current.token : null;
}

/**
 * Atomically replaces an enabled automation's active webhook token. Returning
 * null means the webhook was disabled, the automation was disabled, or it was
 * deleted before the rotation acquired its row lock.
 */
export async function rotateCustomAutomationWebhookToken(
  id: string,
  token: string,
  client: DatabaseOrTransaction = db,
): Promise<string | null> {
  const [rotated] = await client
    .update(customAutomations)
    .set({ webhookSecret: token, updatedAt: new Date() })
    .where(
      and(
        eq(customAutomations.id, id),
        eq(customAutomations.enabled, true),
        isNotNull(customAutomations.webhookSecret),
      ),
    )
    .returning({ webhookSecret: customAutomations.webhookSecret });
  return rotated?.webhookSecret ? decryptText(rotated.webhookSecret) : null;
}

export async function createCustomAutomation(
  input: CustomAutomationWriteInput,
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation> {
  const {
    name,
    prompt,
    cronExpression,
    model,
    reasoningEffort,
    launchCriteria,
    runWhen,
  } = assertValidWriteInput(input);

  const { executionMode, allRepositories, noRepositories } = getExecutionTarget(
    input.environmentId,
  );
  const environment =
    allRepositories || noRepositories || executionMode === 'fast'
      ? null
      : await client.query.environments.findFirst({
          columns: { id: true },
          where: eq(environments.id, input.environmentId),
        });

  if (
    executionMode === 'sandbox_task' &&
    !allRepositories &&
    !noRepositories &&
    !environment
  ) {
    throw new Error('Selected environment was not found.');
  }

  const [created] = await client
    .insert(customAutomations)
    .values({
      name,
      prompt,
      launchCriteria: launchCriteria ?? null,
      runWhen: runWhen ?? null,
      enabled: input.enabled,
      resultPriority: input.resultPriority ?? 'normal',
      scheduleMode: input.scheduleMode,
      cronExpression,
      model,
      reasoningEffort,
      environmentId:
        allRepositories || noRepositories || executionMode === 'fast'
          ? null
          : input.environmentId,
      allRepositories,
      noRepositories,
      executionMode,
      target: input.target,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();

  if (!created) {
    throw new Error('Failed to create custom automation.');
  }

  return created;
}

export async function updateCustomAutomation(
  id: string,
  input: CustomAutomationWriteInput,
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation> {
  const {
    name,
    prompt,
    cronExpression,
    model,
    reasoningEffort,
    launchCriteria,
    runWhen,
  } = assertValidWriteInput(input);

  const existing = await getCustomAutomationById(id, client);
  if (!existing) {
    throw new Error('Custom automation was not found.');
  }

  const { executionMode, allRepositories, noRepositories } = getExecutionTarget(
    input.environmentId,
  );
  const environment =
    allRepositories || noRepositories || executionMode === 'fast'
      ? null
      : await client.query.environments.findFirst({
          columns: { id: true },
          where: eq(environments.id, input.environmentId),
        });

  if (
    executionMode === 'sandbox_task' &&
    !allRepositories &&
    !noRepositories &&
    !environment
  ) {
    throw new Error('Selected environment was not found.');
  }

  const [updated] = await client
    .update(customAutomations)
    .set({
      name,
      prompt,
      launchCriteria:
        launchCriteria === undefined ? existing.launchCriteria : launchCriteria,
      runWhen: runWhen === undefined ? existing.runWhen : runWhen,
      enabled: input.enabled,
      resultPriority: input.resultPriority ?? existing.resultPriority,
      scheduleMode: input.scheduleMode,
      cronExpression,
      model,
      reasoningEffort,
      environmentId:
        allRepositories || noRepositories || executionMode === 'fast'
          ? null
          : input.environmentId,
      allRepositories,
      noRepositories,
      executionMode,
      target: input.target,
      // Disabling the automation also revokes its external trigger URL.
      ...(!input.enabled ? { webhookSecret: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customAutomations.id, id))
    .returning();

  if (!updated) {
    throw new Error('Failed to update custom automation.');
  }

  return updated;
}

export async function deleteCustomAutomation(
  id: string,
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client.delete(customAutomations).where(eq(customAutomations.id, id));
}

export async function recordCustomAutomationRunOutcome(
  client: DatabaseOrTransaction,
  params: {
    id: string;
    status: AutomationRunOutcomeStatus;
    at?: Date;
    error?: string | null;
    lastLaunchedTaskId?: string | null;
    lastRunAt?: Date | 'skip';
    /**
     * When finalizing a claimed launch (success or failure after claim), pass
     * the fencing token so a reclaimed claim cannot be stomped by a slow
     * first launcher. Omit for pre-claim bookkeeping updates that must not
     * touch launchClaimedAt / lastLaunchedTaskId.
     */
    launchClaimedAt?: Date;
  },
): Promise<boolean> {
  const at = params.at ?? new Date();
  const update: Partial<typeof customAutomations.$inferInsert> = {
    updatedAt: at,
  };
  const requestedLastRunAt =
    params.lastRunAt === 'skip' ? null : (params.lastRunAt ?? at);
  const lastRunAtUpdate = requestedLastRunAt
    ? sql`GREATEST(${customAutomations.lastRunAt}, ${sql.param(
        requestedLastRunAt,
        customAutomations.lastRunAt,
      )})`
    : undefined;

  if (params.launchClaimedAt) {
    update.launchClaimedAt = null;
  }

  if (params.launchClaimedAt && params.lastLaunchedTaskId !== undefined) {
    update.lastLaunchedTaskId = params.lastLaunchedTaskId;
  }

  if (params.status === 'failed') {
    update.lastFailedAt = at;
    update.lastError = params.error?.trim() || 'Custom automation run failed.';
  } else {
    update.lastError = null;

    if (params.status === 'succeeded') {
      update.lastSucceededAt = at;
    }
  }

  const where = params.launchClaimedAt
    ? and(
        eq(customAutomations.id, params.id),
        eq(customAutomations.launchClaimedAt, params.launchClaimedAt),
      )
    : eq(customAutomations.id, params.id);

  const updated = await client
    .update(customAutomations)
    .set({
      ...update,
      ...(lastRunAtUpdate ? { lastRunAt: lastRunAtUpdate } : {}),
    })
    .where(where)
    .returning({ id: customAutomations.id });

  return updated.length > 0;
}

/**
 * Atomically claim a custom automation launch. Succeeds only when no other
 * launcher holds a fresh claim. Completed claims do not block later scheduled
 * runs, even if the previously launched task still appears active.
 * Returns the claim fencing token (`launchClaimedAt`) on success, or null.
 */
export async function tryClaimCustomAutomationLaunch(
  id: string,
  expectedLastRunAt: Date | null,
  client: DatabaseOrTransaction = db,
): Promise<Date | null> {
  const now = new Date();
  const staleBefore = new Date(
    now.getTime() - CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS,
  );

  const [claimed] = await client
    .update(customAutomations)
    .set({
      launchClaimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(customAutomations.id, id),
        or(
          isNull(customAutomations.launchClaimedAt),
          lt(customAutomations.launchClaimedAt, staleBefore),
        )!,
        expectedLastRunAt
          ? eq(customAutomations.lastRunAt, expectedLastRunAt)
          : isNull(customAutomations.lastRunAt),
      ),
    )
    .returning({ launchClaimedAt: customAutomations.launchClaimedAt });

  return claimed?.launchClaimedAt ?? null;
}

export async function releaseCustomAutomationLaunchClaim(
  id: string,
  launchClaimedAt: Date,
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client
    .update(customAutomations)
    .set({
      launchClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customAutomations.id, id),
        eq(customAutomations.launchClaimedAt, launchClaimedAt),
      ),
    );
}

export function getCustomAutomationFrequency(
  automation: Pick<CustomAutomation, 'enabled' | 'scheduleMode'>,
): ScheduleOnlyBackgroundAutomationFrequency {
  if (!automation.enabled) {
    return 'off';
  }

  return isScheduleOnlyBackgroundAutomationFrequency(automation.scheduleMode)
    ? automation.scheduleMode
    : 'off';
}

/**
 * Returns true when the previously launched task is still active.
 */
export async function isCustomAutomationPreviousRunActive(
  automation: Pick<CustomAutomation, 'lastLaunchedTaskId'>,
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  if (!automation.lastLaunchedTaskId) {
    return false;
  }

  const task = await client.query.tasks.findFirst({
    columns: { state: true },
    where: eq(tasks.id, automation.lastLaunchedTaskId),
  });

  return task?.state === 'active';
}
