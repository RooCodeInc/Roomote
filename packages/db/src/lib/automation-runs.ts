import { randomUUID } from 'node:crypto';

import { and, count, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';

import {
  fastAutomationExecutionPolicySchema,
  type AutomationDeliveryTarget,
  type AutomationRunEffectKind,
  type AutomationRunStatus,
  type AutomationRunTriggerKind,
  type BackgroundAutomationKey,
  type FastAutomationExecutionPolicy,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import {
  automationRunChildren,
  automationRunEffects,
  automationRuns,
} from '../schema';
import type { AutomationRun, AutomationRunEffect } from '../types';

const ACTIVE_AUTOMATION_RUN_STATUSES = ['pending', 'running'] as const;
const AUTOMATION_EFFECT_STALE_MS = 5 * 60_000;

export type AutomationRunSource =
  | { automationKey: BackgroundAutomationKey; customAutomationId?: never }
  | { automationKey?: never; customAutomationId: string };

function getAutomationRunSourceKey(source: AutomationRunSource): string {
  return source.automationKey
    ? `built_in:${source.automationKey}`
    : `custom:${source.customAutomationId}`;
}

export async function claimAutomationRun(
  input: AutomationRunSource & {
    triggerKind: AutomationRunTriggerKind;
    occurrenceKey: string;
    promptSnapshot: string;
    policySnapshot: FastAutomationExecutionPolicy;
    destination?: AutomationDeliveryTarget | null;
    createdByUserId?: string | null;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: Date;
  },
  client: DatabaseOrTransaction = db,
): Promise<{ run: AutomationRun; acquired: boolean; resumed: boolean }> {
  const now = input.now ?? new Date();
  const sourceKey = getAutomationRunSourceKey(input);
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
  const policySnapshot = fastAutomationExecutionPolicySchema.parse(
    input.policySnapshot,
  );

  const inserted = await client
    .insert(automationRuns)
    .values({
      sourceKey,
      automationKey: input.automationKey ?? null,
      customAutomationId: input.customAutomationId ?? null,
      triggerKind: input.triggerKind,
      occurrenceKey: input.occurrenceKey,
      status: 'pending',
      promptSnapshot: input.promptSnapshot,
      policySnapshot,
      policyVersion: policySnapshot.version,
      createdByUserId: input.createdByUserId ?? null,
      destination: input.destination ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: automationRuns.id });

  const [claimed] = await client
    .update(automationRuns)
    .set({
      status: 'running',
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      startedAt: sql`COALESCE(${automationRuns.startedAt}, ${now.toISOString()}::timestamp)`,
      attemptCount: sql`${automationRuns.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.sourceKey, sourceKey),
        eq(automationRuns.occurrenceKey, input.occurrenceKey),
        inArray(automationRuns.status, [...ACTIVE_AUTOMATION_RUN_STATUSES]),
        or(
          eq(automationRuns.leaseOwner, input.leaseOwner),
          lt(automationRuns.leaseExpiresAt, now),
          sql`${automationRuns.leaseExpiresAt} IS NULL`,
        ),
      ),
    )
    .returning();

  if (claimed) {
    return {
      run: claimed,
      acquired: true,
      resumed: inserted.length === 0,
    };
  }

  const existing = await client.query.automationRuns.findFirst({
    where: and(
      eq(automationRuns.sourceKey, sourceKey),
      eq(automationRuns.occurrenceKey, input.occurrenceKey),
    ),
  });
  if (!existing) {
    throw new Error('Automation run occurrence disappeared during claim.');
  }

  return { run: existing, acquired: false, resumed: false };
}

export async function getActiveAutomationRunForPrincipal(
  input: {
    automationRunId: string;
    leaseOwner: string;
    policyVersion: number;
    now?: Date;
  },
  client: DatabaseOrTransaction = db,
): Promise<AutomationRun | null> {
  const now = input.now ?? new Date();
  const run = await client.query.automationRuns.findFirst({
    where: and(
      eq(automationRuns.id, input.automationRunId),
      eq(automationRuns.status, 'running'),
      eq(automationRuns.leaseOwner, input.leaseOwner),
      eq(automationRuns.policyVersion, input.policyVersion),
      gt(automationRuns.leaseExpiresAt, now),
    ),
  });

  return run ?? null;
}

export async function renewAutomationRunLease(
  input: {
    automationRunId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: Date;
  },
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [updated] = await client
    .update(automationRuns)
    .set({
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.id, input.automationRunId),
        eq(automationRuns.status, 'running'),
        eq(automationRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: automationRuns.id });
  return Boolean(updated);
}

export async function completeAutomationRun(
  input: {
    automationRunId: string;
    leaseOwner: string;
    status: Exclude<
      AutomationRunStatus,
      'pending' | 'running' | 'waiting_for_children'
    >;
    error?: string | null;
    orchestrationSessionId?: string | null;
    now?: Date;
  },
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [updated] = await client
    .update(automationRuns)
    .set({
      status: input.status,
      completedAt: now,
      lastError: input.error ?? null,
      orchestrationSessionId: input.orchestrationSessionId ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.id, input.automationRunId),
        eq(automationRuns.status, 'running'),
        eq(automationRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: automationRuns.id });
  return Boolean(updated);
}

export async function suspendAutomationRunForChildren(
  input: { automationRunId: string; leaseOwner: string },
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const [updated] = await client
    .update(automationRuns)
    .set({
      status: 'waiting_for_children',
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationRuns.id, input.automationRunId),
        eq(automationRuns.status, 'running'),
        eq(automationRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: automationRuns.id });
  return Boolean(updated);
}

export async function resumeAutomationRunAfterChildren(input: {
  automationRunId: string;
  leaseOwner: string;
  leaseDurationMs: number;
}): Promise<AutomationRun | null> {
  const now = new Date();
  const [updated] = await db
    .update(automationRuns)
    .set({
      status: 'running',
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      attemptCount: sql`${automationRuns.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRuns.id, input.automationRunId),
        eq(automationRuns.status, 'waiting_for_children'),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function beginAutomationRunEffect(
  input: {
    automationRunId: string;
    logicalKey: string;
    kind: AutomationRunEffectKind;
    requestSignature?: string | null;
    integrationId?: string | null;
    toolName?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  client: DatabaseOrTransaction = db,
): Promise<{
  effect: AutomationRunEffect;
  shouldExecute: boolean;
  inFlight: boolean;
}> {
  const now = new Date();
  const [created] = await client
    .insert(automationRunEffects)
    .values({ ...input, status: 'executing' })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { effect: created, shouldExecute: true, inFlight: false };
  }

  const [reclaimed] = await client
    .update(automationRunEffects)
    .set({ attemptToken: randomUUID(), startedAt: now, updatedAt: now })
    .where(
      and(
        eq(automationRunEffects.automationRunId, input.automationRunId),
        eq(automationRunEffects.logicalKey, input.logicalKey),
        eq(automationRunEffects.status, 'executing'),
        lt(
          automationRunEffects.updatedAt,
          new Date(now.getTime() - AUTOMATION_EFFECT_STALE_MS),
        ),
      ),
    )
    .returning();
  if (reclaimed) {
    return { effect: reclaimed, shouldExecute: true, inFlight: false };
  }

  const existing = await client.query.automationRunEffects.findFirst({
    where: and(
      eq(automationRunEffects.automationRunId, input.automationRunId),
      eq(automationRunEffects.logicalKey, input.logicalKey),
    ),
  });
  if (!existing) {
    throw new Error('Automation run effect disappeared during claim.');
  }

  return {
    effect: existing,
    shouldExecute: false,
    inFlight: existing.status === 'executing',
  };
}

export async function getAutomationRunEffect(
  automationRunId: string,
  logicalKey: string,
  client: DatabaseOrTransaction = db,
): Promise<AutomationRunEffect | null> {
  return (
    (await client.query.automationRunEffects.findFirst({
      where: and(
        eq(automationRunEffects.automationRunId, automationRunId),
        eq(automationRunEffects.logicalKey, logicalKey),
      ),
    })) ?? null
  );
}

export async function claimAutomationRunEffectWithinBudget(input: {
  automationRunId: string;
  logicalKey: string;
  kind: AutomationRunEffectKind;
  maxEffects: number;
  requestSignature?: string | null;
  integrationId?: string | null;
  toolName?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<
  | {
      budgetExceeded: true;
      effect: null;
      shouldExecute: false;
      inFlight: false;
    }
  | {
      budgetExceeded: false;
      effect: AutomationRunEffect;
      shouldExecute: boolean;
      inFlight: boolean;
    }
> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`automation-effect-budget:${input.automationRunId}:${input.kind}`}))`,
    );
    const existing = await tx.query.automationRunEffects.findFirst({
      where: and(
        eq(automationRunEffects.automationRunId, input.automationRunId),
        eq(automationRunEffects.logicalKey, input.logicalKey),
      ),
    });
    if (existing) {
      if (
        existing.status === 'executing' &&
        existing.updatedAt.getTime() < Date.now() - AUTOMATION_EFFECT_STALE_MS
      ) {
        const [reclaimed] = await tx
          .update(automationRunEffects)
          .set({
            attemptToken: randomUUID(),
            startedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(automationRunEffects.id, existing.id))
          .returning();
        if (!reclaimed) throw new Error('Failed to reclaim automation effect.');
        return {
          budgetExceeded: false as const,
          effect: reclaimed,
          shouldExecute: true,
          inFlight: false,
        };
      }
      return {
        budgetExceeded: false as const,
        effect: existing,
        shouldExecute: false,
        inFlight: existing.status === 'executing',
      };
    }
    const total = await countAutomationRunEffects(
      input.automationRunId,
      input.kind,
      tx,
    );
    if (total >= input.maxEffects) {
      return {
        budgetExceeded: true as const,
        effect: null,
        shouldExecute: false as const,
        inFlight: false as const,
      };
    }
    const [created] = await tx
      .insert(automationRunEffects)
      .values({
        automationRunId: input.automationRunId,
        logicalKey: input.logicalKey,
        kind: input.kind,
        requestSignature: input.requestSignature,
        integrationId: input.integrationId,
        toolName: input.toolName,
        metadata: input.metadata,
        status: 'executing',
      })
      .returning();
    if (!created) throw new Error('Failed to claim automation run effect.');
    return {
      budgetExceeded: false as const,
      effect: created,
      shouldExecute: true,
      inFlight: false,
    };
  });
}

export async function completeAutomationRunEffect(
  input: {
    id: string;
    attemptToken: string;
    status: 'succeeded' | 'failed';
    externalId?: string | null;
    metadata?: Record<string, unknown> | null;
    resultPreview?: string | null;
    error?: string | null;
    now?: Date;
  },
  client: DatabaseOrTransaction = db,
): Promise<void> {
  const now = input.now ?? new Date();
  const [updated] = await client
    .update(automationRunEffects)
    .set({
      status: input.status,
      ...(input.externalId !== undefined
        ? { externalId: input.externalId }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.resultPreview !== undefined
        ? { resultPreview: input.resultPreview }
        : {}),
      error: input.status === 'succeeded' ? null : (input.error ?? null),
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationRunEffects.id, input.id),
        eq(automationRunEffects.status, 'executing'),
        eq(automationRunEffects.attemptToken, input.attemptToken),
      ),
    )
    .returning({ id: automationRunEffects.id });

  if (!updated) {
    throw new Error('Automation run effect was not found.');
  }
}

export async function recordAutomationRunEffectExternalId(
  input: {
    id: string;
    attemptToken: string;
    externalId: string;
    metadata?: Record<string, unknown> | null;
  },
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client
    .update(automationRunEffects)
    .set({
      externalId: input.externalId,
      metadata: input.metadata ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationRunEffects.id, input.id),
        eq(automationRunEffects.status, 'executing'),
        eq(automationRunEffects.attemptToken, input.attemptToken),
      ),
    );
}

export async function retryAutomationRunEffect(
  effectId: string,
  client: DatabaseOrTransaction = db,
): Promise<AutomationRunEffect | null> {
  const now = new Date();
  const [updated] = await client
    .update(automationRunEffects)
    .set({
      status: 'executing',
      attemptToken: randomUUID(),
      startedAt: now,
      error: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationRunEffects.id, effectId),
        eq(automationRunEffects.status, 'failed'),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function listRetryableAutomationReportDeliveries(
  limit = 25,
  client: DatabaseOrTransaction = db,
): Promise<Array<{ automationRunId: string; logicalMessageKey: string }>> {
  const rows = await client
    .select({
      automationRunId: automationRunEffects.automationRunId,
      logicalKey: automationRunEffects.logicalKey,
    })
    .from(automationRunEffects)
    .where(
      and(
        eq(automationRunEffects.kind, 'message_delivery'),
        or(
          eq(automationRunEffects.status, 'failed'),
          and(
            eq(automationRunEffects.status, 'executing'),
            lt(
              automationRunEffects.updatedAt,
              new Date(Date.now() - AUTOMATION_EFFECT_STALE_MS),
            ),
          ),
        ),
      ),
    )
    .orderBy(automationRunEffects.updatedAt)
    .limit(limit);
  return rows.flatMap((row) =>
    row.logicalKey.startsWith('message:')
      ? [
          {
            automationRunId: row.automationRunId,
            logicalMessageKey: row.logicalKey.slice('message:'.length),
          },
        ]
      : [],
  );
}

export async function countAutomationRunEffects(
  automationRunId: string,
  kind: AutomationRunEffectKind,
  client: DatabaseOrTransaction = db,
): Promise<number> {
  const [row] = await client
    .select({ total: count() })
    .from(automationRunEffects)
    .where(
      and(
        eq(automationRunEffects.automationRunId, automationRunId),
        eq(automationRunEffects.kind, kind),
      ),
    );
  return row?.total ?? 0;
}

export async function bindAutomationRunDelivery(
  input: {
    automationRunId: string;
    messageId: string;
    threadId: string;
  },
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client
    .update(automationRuns)
    .set({
      deliveryMessageId: sql`COALESCE(${automationRuns.deliveryMessageId}, ${input.messageId})`,
      deliveryThreadId: sql`COALESCE(${automationRuns.deliveryThreadId}, ${input.threadId})`,
      updatedAt: new Date(),
    })
    .where(eq(automationRuns.id, input.automationRunId));
}

export async function getAutomationRunById(
  automationRunId: string,
  client: DatabaseOrTransaction = db,
): Promise<AutomationRun | null> {
  return (
    (await client.query.automationRuns.findFirst({
      where: eq(automationRuns.id, automationRunId),
    })) ?? null
  );
}

export async function recordAutomationRunUsage(
  input: {
    automationRunId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  },
  client: DatabaseOrTransaction = db,
): Promise<void> {
  await client
    .update(automationRuns)
    .set({
      inputTokens: sql`COALESCE(${automationRuns.inputTokens}, 0) + ${input.inputTokens}`,
      outputTokens: sql`COALESCE(${automationRuns.outputTokens}, 0) + ${input.outputTokens}`,
      ...(input.costUsd === null
        ? {}
        : {
            costUsd: sql`COALESCE(${automationRuns.costUsd}, 0) + ${input.costUsd}`,
          }),
      updatedAt: new Date(),
    })
    .where(eq(automationRuns.id, input.automationRunId));
}

export async function linkAutomationRunChild(
  input: {
    automationRunId: string;
    logicalLaunchKey: string;
    taskId: string;
  },
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const [created] = await client
    .insert(automationRunChildren)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: automationRunChildren.id });
  return Boolean(created);
}

export async function claimAutomationRunChildLink(input: {
  automationRunId: string;
  logicalLaunchKey: string;
  taskId: string;
  effectId: string;
  attemptToken: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [ownedEffect] = await tx
      .update(automationRunEffects)
      .set({
        externalId: input.taskId,
        metadata: input.metadata ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationRunEffects.id, input.effectId),
          eq(automationRunEffects.status, 'executing'),
          eq(automationRunEffects.attemptToken, input.attemptToken),
        ),
      )
      .returning({ id: automationRunEffects.id });
    if (!ownedEffect) return false;

    const [created] = await tx
      .insert(automationRunChildren)
      .values({
        automationRunId: input.automationRunId,
        logicalLaunchKey: input.logicalLaunchKey,
        taskId: input.taskId,
      })
      .onConflictDoNothing()
      .returning({ id: automationRunChildren.id });
    if (!created) {
      throw new Error('Automation child launch key was already linked.');
    }
    return true;
  });
}

export async function recordAutomationRunChildOutcome(
  input: {
    automationRunId: string;
    taskId: string;
    terminalOutcome: string;
  },
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const [updated] = await client
    .update(automationRunChildren)
    .set({
      terminalOutcome: input.terminalOutcome,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationRunChildren.automationRunId, input.automationRunId),
        eq(automationRunChildren.taskId, input.taskId),
      ),
    )
    .returning({ id: automationRunChildren.id });
  return Boolean(updated);
}

export async function countUnsettledAutomationRunChildren(
  automationRunId: string,
  client: DatabaseOrTransaction = db,
): Promise<number> {
  const [row] = await client
    .select({ total: count() })
    .from(automationRunChildren)
    .where(
      and(
        eq(automationRunChildren.automationRunId, automationRunId),
        sql`${automationRunChildren.terminalOutcome} IS NULL`,
      ),
    );
  return row?.total ?? 0;
}

export async function countAutomationRunChildren(
  automationRunId: string,
  client: DatabaseOrTransaction = db,
): Promise<number> {
  const [row] = await client
    .select({ total: count() })
    .from(automationRunChildren)
    .where(eq(automationRunChildren.automationRunId, automationRunId));
  return row?.total ?? 0;
}

export async function listReadyAutomationRunsForContinuation(
  limit = 10,
  client: DatabaseOrTransaction = db,
): Promise<
  Array<{
    id: string;
    automationKey: BackgroundAutomationKey;
    policyVersion: number;
    children: Array<{ taskId: string; terminalOutcome: string }>;
  }>
> {
  const rows = await client
    .select({
      id: automationRuns.id,
      automationKey: automationRuns.automationKey,
      policyVersion: automationRuns.policyVersion,
    })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.status, 'waiting_for_children'),
        sql`NOT EXISTS (
          SELECT 1 FROM ${automationRunChildren}
          WHERE ${automationRunChildren.automationRunId} = ${automationRuns.id}
            AND ${automationRunChildren.terminalOutcome} IS NULL
        )`,
      ),
    )
    .orderBy(automationRuns.updatedAt)
    .limit(limit);
  return Promise.all(
    rows.flatMap((row) =>
      row.automationKey
        ? [
            (async () => ({
              id: row.id,
              automationKey: row.automationKey!,
              policyVersion: row.policyVersion,
              children: (
                await client
                  .select({
                    taskId: automationRunChildren.taskId,
                    terminalOutcome: automationRunChildren.terminalOutcome,
                  })
                  .from(automationRunChildren)
                  .where(eq(automationRunChildren.automationRunId, row.id))
              ).flatMap((child) =>
                child.terminalOutcome
                  ? [
                      {
                        taskId: child.taskId,
                        terminalOutcome: child.terminalOutcome,
                      },
                    ]
                  : [],
              ),
            }))(),
          ]
        : [],
    ),
  );
}
