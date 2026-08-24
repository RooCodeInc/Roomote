import { randomUUID } from 'node:crypto';

import { runFastAutomationExecution } from '@roomote/cloud-agents/server';
import {
  claimAutomationRun,
  completeAutomationRun,
  db,
  recordAutomationRunOutcome,
  listReadyAutomationRunsForContinuation,
  resumeAutomationRunAfterChildren,
} from '@roomote/db/server';
import type {
  AutomationDeliveryTarget,
  AutomationRunTriggerKind,
  BackgroundAutomationKey,
  FastAutomationExecutionPolicy,
} from '@roomote/types';

import { createFastAutomationExecutionAdapter } from './fast-automation-adapter';

const AUTOMATION_RUN_LEASE_MS = 15 * 60_000;

export function buildScheduledAutomationOccurrenceKey(input: {
  automationKey: BackgroundAutomationKey;
  frequency: string;
  now: Date;
  timeZone: string;
  partition?: string;
}): string {
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(input.now);
  const slot =
    input.frequency === 'weekly' ? getWeekSlot(localDate) : localDate;
  return `${input.automationKey}:${input.frequency}:${slot}${input.partition ? `:${input.partition}` : ''}`;
}

function getWeekSlot(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export async function executeFastBuiltInAutomation(input: {
  automationKey: BackgroundAutomationKey;
  triggerKind: AutomationRunTriggerKind;
  occurrenceKey: string;
  prompt: string;
  policy: FastAutomationExecutionPolicy;
  destination: AutomationDeliveryTarget;
}): Promise<{
  acquired: boolean;
  status:
    | 'succeeded'
    | 'skipped'
    | 'failed'
    | 'waiting_for_children'
    | 'already_claimed';
  automationRunId: string;
}> {
  const leaseOwner = randomUUID();
  const claim = await claimAutomationRun({
    automationKey: input.automationKey,
    triggerKind: input.triggerKind,
    occurrenceKey: input.occurrenceKey,
    promptSnapshot: input.prompt,
    policySnapshot: input.policy,
    destination: input.destination,
    leaseOwner,
    leaseDurationMs: AUTOMATION_RUN_LEASE_MS,
  });
  if (!claim.acquired) {
    return {
      acquired: false,
      status: 'already_claimed',
      automationRunId: claim.run.id,
    };
  }

  try {
    const outcome = await runFastAutomationExecution({
      automationRunId: claim.run.id,
      leaseOwner,
      policyVersion: claim.run.policyVersion,
      adapter: createFastAutomationExecutionAdapter(),
    });
    if (outcome.status === 'waiting_for_children') {
      return {
        acquired: true,
        status: 'waiting_for_children',
        automationRunId: claim.run.id,
      };
    }
    await recordAutomationRunOutcome(db, {
      key: input.automationKey,
      status:
        outcome.status === 'failed'
          ? 'failed'
          : outcome.status === 'skipped'
            ? 'skipped'
            : 'succeeded',
      at: new Date(),
      ...(outcome.status === 'failed' && outcome.summary
        ? { error: outcome.summary }
        : {}),
    });
    return {
      acquired: true,
      status: outcome.status,
      automationRunId: claim.run.id,
    };
  } catch (error) {
    await recordAutomationRunOutcome(db, {
      key: input.automationKey,
      status: 'failed',
      at: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function completeFastBuiltInAutomationNoop(input: {
  automationKey: BackgroundAutomationKey;
  triggerKind: AutomationRunTriggerKind;
  occurrenceKey: string;
  prompt: string;
  policy: FastAutomationExecutionPolicy;
  destination: AutomationDeliveryTarget;
}): Promise<string> {
  const leaseOwner = randomUUID();
  const claim = await claimAutomationRun({
    automationKey: input.automationKey,
    triggerKind: input.triggerKind,
    occurrenceKey: input.occurrenceKey,
    promptSnapshot: input.prompt,
    policySnapshot: input.policy,
    destination: input.destination,
    leaseOwner,
    leaseDurationMs: AUTOMATION_RUN_LEASE_MS,
  });
  if (claim.acquired) {
    await completeAutomationRun({
      automationRunId: claim.run.id,
      leaseOwner,
      status: 'skipped',
    });
  }
  await recordAutomationRunOutcome(db, {
    key: input.automationKey,
    status: 'skipped',
    at: new Date(),
  });
  return claim.run.id;
}

export async function recordFastBuiltInAutomationPreflightFailure(input: {
  automationKey: BackgroundAutomationKey;
  triggerKind: AutomationRunTriggerKind;
  occurrenceKey: string;
  policy: FastAutomationExecutionPolicy;
  destination?: AutomationDeliveryTarget | null;
  error: string;
  reportMessage?: string;
}): Promise<string> {
  const leaseOwner = randomUUID();
  const claim = await claimAutomationRun({
    automationKey: input.automationKey,
    triggerKind: input.triggerKind,
    occurrenceKey: input.occurrenceKey,
    promptSnapshot: `Deterministic automation preflight failed: ${input.error}`,
    policySnapshot: input.policy,
    destination: input.destination ?? null,
    leaseOwner,
    leaseDurationMs: AUTOMATION_RUN_LEASE_MS,
  });
  if (claim.acquired) {
    if (input.reportMessage) {
      try {
        await createFastAutomationExecutionAdapter().postReport({
          automationRunId: claim.run.id,
          logicalMessageKey: 'preflight-blocker',
          message: input.reportMessage,
        });
      } catch (error) {
        console.error(
          `[fast-automation-preflight] Failed to deliver blocker for ${input.automationKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await completeAutomationRun({
      automationRunId: claim.run.id,
      leaseOwner,
      status: 'failed',
      error: input.error,
    });
  }
  return claim.run.id;
}

export async function resumeReadyFastAutomationRuns(): Promise<void> {
  const readyRuns = await listReadyAutomationRunsForContinuation();
  for (const ready of readyRuns) {
    const leaseOwner = randomUUID();
    const run = await resumeAutomationRunAfterChildren({
      automationRunId: ready.id,
      leaseOwner,
      leaseDurationMs: AUTOMATION_RUN_LEASE_MS,
    });
    if (!run) continue;
    try {
      const outcome = await runFastAutomationExecution({
        automationRunId: run.id,
        leaseOwner,
        policyVersion: run.policyVersion,
        adapter: createFastAutomationExecutionAdapter(),
        continuation: true,
        prompt: `All delegated child tasks for this automation run have settled:
${ready.children.map((child) => `- ${child.taskId}: ${child.terminalOutcome}`).join('\n')}
Report only a useful result or blocker to the configured destination, then call complete_automation_run. Do not launch duplicate work.`,
      });
      if (outcome.status !== 'waiting_for_children' && run.automationKey) {
        await recordAutomationRunOutcome(db, {
          key: run.automationKey,
          status:
            outcome.status === 'failed'
              ? 'failed'
              : outcome.status === 'skipped'
                ? 'skipped'
                : 'succeeded',
          at: new Date(),
          ...(outcome.status === 'failed' && outcome.summary
            ? { error: outcome.summary }
            : {}),
        });
      }
    } catch (error) {
      console.error(
        `[fast-automation-continuation] Failed to resume ${ready.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
