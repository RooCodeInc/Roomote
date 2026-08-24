import { randomUUID } from 'node:crypto';

import type { FastAutomationExecutionPolicy } from '@roomote/types';
import { eq } from 'drizzle-orm';

import {
  beginAutomationRunEffect,
  claimAutomationRun,
  claimAutomationRunEffectWithinBudget,
  completeAutomationRun,
  completeAutomationRunEffect,
  getActiveAutomationRunForPrincipal,
} from '../automation-runs';
import { db } from '../../db';
import { automationRunEffects, automationRuns } from '../../schema';
import { ensureAutomationRows } from '../automations';

const policy: FastAutomationExecutionPolicy = {
  version: 1,
  allowedToolsByIntegration: { sentry: ['search_issues'] },
  maxIntegrationCalls: 2,
  maxIntegrationResponseBytes: 100_000,
  maxChildTasks: 1,
  allowedEnvironmentIds: [],
  reporting: 'on_findings',
  childKickoff: 'silent_allowed',
};

describe('automation runs', () => {
  beforeEach(async () => {
    await ensureAutomationRows();
    await db.delete(automationRuns);
  });

  it('deduplicates occurrences and permits lease takeover only after expiry', async () => {
    const occurrenceKey = randomUUID();
    const now = new Date('2026-08-23T10:00:00Z');
    const first = await claimAutomationRun({
      automationKey: 'sentry_triage',
      triggerKind: 'schedule',
      occurrenceKey,
      promptSnapshot: 'scan sentry',
      policySnapshot: policy,
      leaseOwner: 'worker-1',
      leaseDurationMs: 60_000,
      now,
    });
    expect(first.acquired).toBe(true);

    const concurrent = await claimAutomationRun({
      automationKey: 'sentry_triage',
      triggerKind: 'schedule',
      occurrenceKey,
      promptSnapshot: 'scan sentry',
      policySnapshot: policy,
      leaseOwner: 'worker-2',
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 30_000),
    });
    expect(concurrent.acquired).toBe(false);
    expect(concurrent.run.id).toBe(first.run.id);

    const resumed = await claimAutomationRun({
      automationKey: 'sentry_triage',
      triggerKind: 'schedule',
      occurrenceKey,
      promptSnapshot: 'scan sentry',
      policySnapshot: { ...policy, version: 2 },
      leaseOwner: 'worker-2',
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 61_000),
    });
    expect(resumed).toMatchObject({ acquired: true, resumed: true });
    expect(resumed.run.attemptCount).toBe(2);
    expect(resumed.run.policyVersion).toBe(1);
  });

  it('reuses terminal effects and records a silent terminal run state', async () => {
    const claim = await claimAutomationRun({
      automationKey: 'announcer',
      triggerKind: 'manual',
      occurrenceKey: randomUUID(),
      promptSnapshot: 'nothing to announce',
      policySnapshot: { ...policy, allowedToolsByIntegration: {} },
      leaseOwner: 'worker-1',
      leaseDurationMs: 60_000,
    });
    const effect = await beginAutomationRunEffect({
      automationRunId: claim.run.id,
      logicalKey: 'message:summary',
      kind: 'message_delivery',
    });
    expect(effect.shouldExecute).toBe(true);
    await completeAutomationRunEffect({
      id: effect.effect.id,
      attemptToken: effect.effect.attemptToken,
      status: 'succeeded',
      externalId: 'message-1',
    });
    const duplicate = await beginAutomationRunEffect({
      automationRunId: claim.run.id,
      logicalKey: 'message:summary',
      kind: 'message_delivery',
    });
    expect(duplicate.shouldExecute).toBe(false);
    expect(duplicate.effect).toMatchObject({
      status: 'succeeded',
      externalId: 'message-1',
    });

    const firstBudgeted = await claimAutomationRunEffectWithinBudget({
      automationRunId: claim.run.id,
      logicalKey: 'integration:first',
      kind: 'integration_call',
      maxEffects: 1,
    });
    const overBudget = await claimAutomationRunEffectWithinBudget({
      automationRunId: claim.run.id,
      logicalKey: 'integration:second',
      kind: 'integration_call',
      maxEffects: 1,
    });
    expect(firstBudgeted.budgetExceeded).toBe(false);
    expect(overBudget).toMatchObject({ budgetExceeded: true, effect: null });
    if (firstBudgeted.budgetExceeded) {
      throw new Error('Expected the first effect to fit within budget.');
    }
    const liveDuplicate = await claimAutomationRunEffectWithinBudget({
      automationRunId: claim.run.id,
      logicalKey: 'integration:first',
      kind: 'integration_call',
      maxEffects: 1,
    });
    expect(liveDuplicate).toMatchObject({
      shouldExecute: false,
      inFlight: true,
    });
    await db
      .update(automationRunEffects)
      .set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(automationRunEffects.id, firstBudgeted.effect.id));
    const staleRetry = await claimAutomationRunEffectWithinBudget({
      automationRunId: claim.run.id,
      logicalKey: 'integration:first',
      kind: 'integration_call',
      maxEffects: 1,
    });
    expect(staleRetry).toMatchObject({
      shouldExecute: true,
      inFlight: false,
    });

    await expect(
      completeAutomationRun({
        automationRunId: claim.run.id,
        leaseOwner: 'worker-1',
        status: 'skipped',
      }),
    ).resolves.toBe(true);
    await expect(
      getActiveAutomationRunForPrincipal({
        automationRunId: claim.run.id,
        leaseOwner: 'worker-1',
        policyVersion: 1,
      }),
    ).resolves.toBeNull();
  });
});
