import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm';

import {
  isScheduleOnlyBackgroundAutomationFrequency,
  type AutomationTarget,
  type CustomAutomationScheduleMode,
  type ScheduleOnlyBackgroundAutomationFrequency,
  CUSTOM_AUTOMATION_NAME_MAX_LENGTH,
  CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH,
  MAX_CUSTOM_AUTOMATIONS,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { customAutomations, environments, tasks } from '../schema';
import type { CustomAutomation } from '../types';
import type { AutomationRunOutcomeStatus } from './automations';

export {
  CUSTOM_AUTOMATION_NAME_MAX_LENGTH,
  CUSTOM_AUTOMATION_PROMPT_MAX_LENGTH,
  MAX_CUSTOM_AUTOMATIONS,
};

/** Stale launch claims older than this may be reclaimed by a later launcher. */
export const CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS = 10 * 60 * 1000;

export type CustomAutomationWriteInput = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: CustomAutomationScheduleMode;
  environmentId: string;
  target: AutomationTarget;
  createdByUserId?: string | null;
};

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function assertValidWriteInput(input: CustomAutomationWriteInput): {
  name: string;
  prompt: string;
} {
  const name = normalizeName(input.name);
  const prompt = input.prompt.trim();

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

  if (!isScheduleOnlyBackgroundAutomationFrequency(input.scheduleMode)) {
    throw new Error(`Invalid schedule mode: ${input.scheduleMode}`);
  }

  if (!input.environmentId) {
    throw new Error('Environment is required.');
  }

  if (
    !input.target?.provider ||
    !input.target?.targetKind ||
    !input.target?.externalRef
  ) {
    throw new Error('A report destination channel is required.');
  }

  return { name, prompt };
}

export async function listCustomAutomations(
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation[]> {
  return client.query.customAutomations.findMany({
    orderBy: [asc(customAutomations.name)],
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

export async function countCustomAutomations(
  client: DatabaseOrTransaction = db,
): Promise<number> {
  const [row] = await client.select({ value: count() }).from(customAutomations);

  return Number(row?.value ?? 0);
}

export async function createCustomAutomation(
  input: CustomAutomationWriteInput,
  client: DatabaseOrTransaction = db,
): Promise<CustomAutomation> {
  const { name, prompt } = assertValidWriteInput(input);

  const existingCount = await countCustomAutomations(client);
  if (existingCount >= MAX_CUSTOM_AUTOMATIONS) {
    throw new Error(
      `You can create at most ${MAX_CUSTOM_AUTOMATIONS} custom automations.`,
    );
  }

  const environment = await client.query.environments.findFirst({
    columns: { id: true },
    where: eq(environments.id, input.environmentId),
  });

  if (!environment) {
    throw new Error('Selected environment was not found.');
  }

  const [created] = await client
    .insert(customAutomations)
    .values({
      name,
      prompt,
      enabled: input.enabled,
      scheduleMode: input.scheduleMode,
      environmentId: input.environmentId,
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
  const { name, prompt } = assertValidWriteInput(input);

  const existing = await getCustomAutomationById(id, client);
  if (!existing) {
    throw new Error('Custom automation was not found.');
  }

  const environment = await client.query.environments.findFirst({
    columns: { id: true },
    where: eq(environments.id, input.environmentId),
  });

  if (!environment) {
    throw new Error('Selected environment was not found.');
  }

  const [updated] = await client
    .update(customAutomations)
    .set({
      name,
      prompt,
      enabled: input.enabled,
      scheduleMode: input.scheduleMode,
      environmentId: input.environmentId,
      target: input.target,
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
  },
): Promise<void> {
  const at = params.at ?? new Date();
  const update: Partial<typeof customAutomations.$inferInsert> = {
    updatedAt: at,
    launchClaimedAt: null,
  };

  if (params.lastRunAt !== 'skip') {
    update.lastRunAt = params.lastRunAt ?? at;
  }

  if (params.lastLaunchedTaskId !== undefined) {
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

  await client
    .update(customAutomations)
    .set(update)
    .where(eq(customAutomations.id, params.id));
}

/**
 * Atomically claim a custom automation launch. Succeeds only when no other
 * launcher holds a fresh claim and there is no active previous task.
 * Returns the claim fencing token (`launchClaimedAt`) on success, or null.
 */
export async function tryClaimCustomAutomationLaunch(
  id: string,
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
        sql`(
          ${customAutomations.lastLaunchedTaskId} IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM tasks t
            WHERE t.id = ${customAutomations.lastLaunchedTaskId}
              AND t.state = 'active'
          )
        )`,
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
