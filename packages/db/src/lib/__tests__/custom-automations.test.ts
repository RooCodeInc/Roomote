import { describe, expect, it } from 'vitest';
import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  NO_REPOSITORIES,
  customAutomationRunWhenSchema,
} from '@roomote/types';

import {
  createCustomAutomation,
  deleteCustomAutomation,
  ensureCustomAutomationWebhookToken,
  getCustomAutomationById,
  getCustomAutomationWebhookState,
  getCustomAutomationWebhookToken,
  listCustomAutomations,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  rotateCustomAutomationWebhookToken,
  setCustomAutomationWebhookToken,
  tryClaimCustomAutomationLaunch,
  updateCustomAutomation,
} from '../custom-automations';
import {
  customAutomations,
  db,
  environments,
  eq,
  taskFactory,
} from '../../server';

describe('custom automations helpers', () => {
  it('stores one encrypted webhook token and supports safe rotation and revocation', async () => {
    const created = await createCustomAutomation({
      name: `On-demand webhook ${Date.now()}`,
      prompt: 'Run only when manually or webhook triggered.',
      enabled: true,
      scheduleMode: 'on_demand',
      environmentId: FAST_EXECUTION,
      target: {},
    });
    const firstToken = 'A'.repeat(43);

    try {
      expect(
        await ensureCustomAutomationWebhookToken(created.id, firstToken),
      ).toBe(firstToken);
      const stored = await db.query.customAutomations.findFirst({
        where: eq(customAutomations.id, created.id),
        columns: { webhookSecret: true },
      });
      expect(stored?.webhookSecret).toBeTruthy();
      expect(stored?.webhookSecret).not.toBe(firstToken);
      expect(await getCustomAutomationWebhookToken(created.id)).toBe(
        firstToken,
      );
      await updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: true,
        scheduleMode: 'on_demand',
        environmentId: FAST_EXECUTION,
        target: {},
      });
      expect(await getCustomAutomationWebhookToken(created.id)).toBe(
        firstToken,
      );

      const replacementToken = 'B'.repeat(43);
      await setCustomAutomationWebhookToken(created.id, replacementToken);
      expect(await getCustomAutomationWebhookToken(created.id)).toBe(
        replacementToken,
      );
      const rotatedToken = 'D'.repeat(43);
      expect(
        await rotateCustomAutomationWebhookToken(created.id, rotatedToken),
      ).toBe(rotatedToken);
      expect(
        await ensureCustomAutomationWebhookToken(created.id, 'C'.repeat(43)),
      ).toBe(rotatedToken);
      expect(await getCustomAutomationWebhookToken(created.id)).toBe(
        rotatedToken,
      );

      await setCustomAutomationWebhookToken(created.id, null);
      expect(await getCustomAutomationWebhookToken(created.id)).toBeNull();
      expect(await getCustomAutomationWebhookState(created.id)).toMatchObject({
        enabled: true,
        token: null,
      });
      await updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: true,
        scheduleMode: 'on_demand',
        environmentId: FAST_EXECUTION,
        target: {},
      });
      expect(await getCustomAutomationWebhookToken(created.id)).toBeNull();
      expect(
        await rotateCustomAutomationWebhookToken(created.id, 'E'.repeat(43)),
      ).toBeNull();

      await setCustomAutomationWebhookToken(created.id, 'C'.repeat(43));
      await updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: false,
        scheduleMode: 'on_demand',
        environmentId: FAST_EXECUTION,
        target: {},
      });
      expect(await getCustomAutomationWebhookToken(created.id)).toBeNull();
      expect(
        await rotateCustomAutomationWebhookToken(created.id, 'G'.repeat(43)),
      ).toBeNull();
      expect(
        await ensureCustomAutomationWebhookToken(created.id, 'F'.repeat(43)),
      ).toBeNull();
    } finally {
      await deleteCustomAutomation(created.id);
    }
  });

  it('persists, preserves, and clears launch criteria and runWhen during edits', async () => {
    const launchCriteria = 'Only investigate new regressions.';
    const runWhen = customAutomationRunWhenSchema.parse({
      all: [
        {
          id: 'new_regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
      ],
    });
    const created = await createCustomAutomation({
      name: `Conditioned report ${Date.now()}`,
      prompt: 'Find current regressions.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: FAST_EXECUTION,
      target: {},
      launchCriteria,
      runWhen,
    });

    expect(created.launchCriteria).toBe(launchCriteria);
    expect(created.runWhen).toEqual(runWhen);

    const preserved = await updateCustomAutomation(created.id, {
      name: created.name,
      prompt: created.prompt,
      enabled: true,
      scheduleMode: 'daily',
      environmentId: FAST_EXECUTION,
      target: {},
    });
    expect(preserved.launchCriteria).toBe(launchCriteria);
    expect(preserved.runWhen).toEqual(runWhen);

    const cleared = await updateCustomAutomation(created.id, {
      name: created.name,
      prompt: created.prompt,
      enabled: true,
      scheduleMode: 'daily',
      environmentId: FAST_EXECUTION,
      target: {},
      launchCriteria: null,
      runWhen: null,
    });
    expect(cleared.launchCriteria).toBeNull();
    expect(cleared.runWhen).toBeNull();

    await deleteCustomAutomation(created.id);
  });

  it('persists Fast as an execution mode without an environment', async () => {
    const created = await createCustomAutomation({
      name: `Fast digest ${Date.now()}`,
      prompt: 'Summarize actionable work using Fast.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: FAST_EXECUTION,
      target: {},
    });

    expect(created.executionMode).toBe('fast');
    expect(created.environmentId).toBeNull();
    expect(created.allRepositories).toBe(false);
    expect(created.noRepositories).toBe(false);

    await deleteCustomAutomation(created.id);
  });

  it('persists an explicit all-repositories workspace target', async () => {
    const created = await createCustomAutomation({
      name: `Org-wide digest ${Date.now()}`,
      prompt: 'Summarize actionable work across the organization.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: ALL_REPOSITORIES,
      target: {},
    });

    expect(created.environmentId).toBeNull();
    expect(created.allRepositories).toBe(true);
    expect(created.noRepositories).toBe(false);

    await deleteCustomAutomation(created.id);
  });

  it('persists an explicit Blank slate sandbox target', async () => {
    const created = await createCustomAutomation({
      name: `Blank slate artifact ${Date.now()}`,
      prompt: 'Create an artifact without source code.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: NO_REPOSITORIES,
      target: {},
    });

    expect(created.executionMode).toBe('sandbox_task');
    expect(created.environmentId).toBeNull();
    expect(created.allRepositories).toBe(false);
    expect(created.noRepositories).toBe(true);

    await deleteCustomAutomation(created.id);
  });

  it('creates, lists, updates, and deletes a custom automation', async () => {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `custom-auto-env-${Date.now()}`,
        config: {
          name: 'test',
          repositories: [],
        },
      })
      .returning();

    expect(environment).toBeTruthy();

    const created = await createCustomAutomation({
      name: `Flaky scan ${Date.now()}`,
      prompt: 'Scan for flaky tests.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: environment!.id,
      target: {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'CABC123',
      },
    });

    expect(created.id).toBeTruthy();
    expect(created.scheduleMode).toBe('daily');

    const listed = await listCustomAutomations();
    expect(listed.some((row) => row.id === created.id)).toBe(true);

    const updated = await updateCustomAutomation(created.id, {
      name: created.name,
      prompt: 'Scan for flaky tests (updated).',
      enabled: false,
      scheduleMode: 'weekly',
      environmentId: environment!.id,
      target: {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'CABC123',
      },
    });

    expect(updated.enabled).toBe(false);
    expect(updated.scheduleMode).toBe('weekly');
    expect(updated.prompt).toContain('updated');

    await deleteCustomAutomation(created.id);
    expect(await getCustomAutomationById(created.id)).toBeNull();
  });

  it('creates a custom automation without a report destination', async () => {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `custom-auto-env-nodest-${Date.now()}`,
        config: {
          name: 'test',
          repositories: [],
        },
      })
      .returning();

    const created = await createCustomAutomation({
      name: `Silent scan ${Date.now()}`,
      prompt: 'Scan for flaky tests without reporting to a channel.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: environment!.id,
      target: {},
    });

    expect(created.target).toEqual({});

    await deleteCustomAutomation(created.id);
  });

  it('creates custom automations beyond the former deployment cap', async () => {
    const createdIds: string[] = [];

    try {
      for (let index = 0; index < 26; index += 1) {
        const created = await createCustomAutomation({
          name: `Beyond cap ${Date.now()} ${index}`,
          prompt: 'Verify that custom automation creation remains available.',
          enabled: false,
          scheduleMode: 'daily',
          environmentId: FAST_EXECUTION,
          target: {},
        });
        createdIds.push(created.id);
      }

      expect(createdIds).toHaveLength(26);
    } finally {
      await Promise.all(createdIds.map((id) => deleteCustomAutomation(id)));
    }
  });

  it('persists canonical cron schedules and rejects invalid mode combinations', async () => {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `custom-auto-env-cron-${Date.now()}`,
        config: { name: 'test', repositories: [] },
      })
      .returning();

    const created = await createCustomAutomation({
      name: `Cron scan ${Date.now()}`,
      prompt: 'Scan every weekday morning.',
      enabled: true,
      scheduleMode: 'cron',
      cronExpression: '0 9 * * 1-5',
      environmentId: environment!.id,
      target: {},
    });
    expect(created.scheduleMode).toBe('cron');
    expect(created.cronExpression).toBe('0 9 * * 1-5');

    await expect(
      updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: '0 9 * * *',
        environmentId: environment!.id,
        target: {},
      }),
    ).rejects.toThrow('only valid for a cron schedule');

    await deleteCustomAutomation(created.id);
  });

  it('persists model and effort overrides and rejects invalid combinations', async () => {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `custom-auto-env-model-${Date.now()}`,
        config: { name: 'test', repositories: [] },
      })
      .returning();

    const created = await createCustomAutomation({
      name: `Model override ${Date.now()}`,
      prompt: 'Scan with a pinned model.',
      enabled: true,
      scheduleMode: 'daily',
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'high',
      environmentId: environment!.id,
      target: {},
    });
    expect(created.model).toBe('anthropic/claude-sonnet-5');
    expect(created.reasoningEffort).toBe('high');

    const cleared = await updateCustomAutomation(created.id, {
      name: created.name,
      prompt: created.prompt,
      enabled: true,
      scheduleMode: 'daily',
      model: null,
      reasoningEffort: null,
      environmentId: environment!.id,
      target: {},
    });
    expect(cleared.model).toBeNull();
    expect(cleared.reasoningEffort).toBeNull();

    await expect(
      updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: true,
        scheduleMode: 'daily',
        reasoningEffort: 'medium',
        environmentId: environment!.id,
        target: {},
      }),
    ).rejects.toThrow('requires a model override');

    await expect(
      updateCustomAutomation(created.id, {
        name: created.name,
        prompt: created.prompt,
        enabled: true,
        scheduleMode: 'daily',
        model: 'no-provider-prefix',
        environmentId: environment!.id,
        target: {},
      }),
    ).rejects.toThrow('provider/model format');

    await deleteCustomAutomation(created.id);
  });

  it('claims a launch while the previous task is still active', async () => {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `custom-auto-env-claim-${Date.now()}`,
        config: {
          name: 'test',
          repositories: [],
        },
      })
      .returning();

    const created = await createCustomAutomation({
      name: `Claim gate ${Date.now()}`,
      prompt: 'Scan for flaky tests.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: environment!.id,
      target: {},
    });

    const activeTask = await taskFactory.create({ state: 'active' });
    await db
      .update(customAutomations)
      .set({ lastLaunchedTaskId: activeTask.id })
      .where(eq(customAutomations.id, created.id));

    const claim = await tryClaimCustomAutomationLaunch(
      created.id,
      created.lastRunAt,
    );
    expect(claim).toBeInstanceOf(Date);

    // The claim fence still guards concurrent launches.
    expect(
      await tryClaimCustomAutomationLaunch(created.id, created.lastRunAt),
    ).toBeNull();

    await recordCustomAutomationRunOutcome(db, {
      id: created.id,
      status: 'succeeded',
      launchClaimedAt: claim!,
      lastLaunchedTaskId: activeTask.id,
    });

    // An evaluator that read the old due state cannot relaunch after the first
    // evaluator completes and clears its claim.
    expect(
      await tryClaimCustomAutomationLaunch(created.id, created.lastRunAt),
    ).toBeNull();

    const completed = await getCustomAutomationById(created.id);
    const nextClaim = await tryClaimCustomAutomationLaunch(
      created.id,
      completed!.lastRunAt,
    );
    expect(nextClaim).toBeInstanceOf(Date);

    await releaseCustomAutomationLaunchClaim(created.id, nextClaim!);
    await deleteCustomAutomation(created.id);
  });

  it('records a manual retry occurrence and keeps later webhook ordering', async () => {
    const created = await createCustomAutomation({
      name: `Concurrent webhook outcome ${Date.now()}`,
      prompt: 'Review the supplied event.',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: FAST_EXECUTION,
      target: {},
    });
    const failedOccurrenceAt = new Date(Date.now() - 120_000);
    await db
      .update(customAutomations)
      .set({ lastRunAt: failedOccurrenceAt, lastError: 'Previous run failed.' })
      .where(eq(customAutomations.id, created.id));

    const retryClaimedAt = await tryClaimCustomAutomationLaunch(
      created.id,
      failedOccurrenceAt,
    );
    expect(retryClaimedAt).toBeInstanceOf(Date);
    expect(retryClaimedAt!.getTime()).toBeGreaterThan(
      failedOccurrenceAt.getTime(),
    );
    let activeClaim = retryClaimedAt;

    try {
      await expect(
        recordCustomAutomationRunOutcome(db, {
          id: created.id,
          status: 'succeeded',
          at: new Date(retryClaimedAt!.getTime() + 30_000),
          lastRunAt: retryClaimedAt!,
          launchClaimedAt: retryClaimedAt!,
        }),
      ).resolves.toBe(true);

      activeClaim = null;
      const afterRetry = await getCustomAutomationById(created.id);
      expect(afterRetry?.lastRunAt?.getTime()).toBe(retryClaimedAt!.getTime());
      expect(afterRetry?.lastSucceededAt?.getTime()).toBe(
        retryClaimedAt!.getTime() + 30_000,
      );
      expect(afterRetry?.lastError).toBeNull();
      expect(afterRetry?.launchClaimedAt).toBeNull();

      const scheduleClaimedAt = await tryClaimCustomAutomationLaunch(
        created.id,
        retryClaimedAt!,
      );
      expect(scheduleClaimedAt).toBeInstanceOf(Date);
      activeClaim = scheduleClaimedAt;

      const webhookOccurrenceAt = new Date(
        scheduleClaimedAt!.getTime() + 120_000,
      );
      const webhookSettledAt = new Date(webhookOccurrenceAt.getTime() + 30_000);
      await recordCustomAutomationRunOutcome(db, {
        id: created.id,
        status: 'succeeded',
        at: webhookSettledAt,
        lastRunAt: webhookOccurrenceAt,
      });

      await expect(
        recordCustomAutomationRunOutcome(db, {
          id: created.id,
          status: 'failed',
          at: new Date(webhookSettledAt.getTime() + 30_000),
          error: 'Older webhook completion arrived later.',
          lastRunAt: new Date(scheduleClaimedAt!.getTime() + 60_000),
        }),
      ).resolves.toBe(true);

      const afterOlderWebhook = await getCustomAutomationById(created.id);
      expect(afterOlderWebhook?.lastRunAt?.getTime()).toBe(
        webhookOccurrenceAt.getTime(),
      );
      expect(afterOlderWebhook?.launchClaimedAt?.getTime()).toBe(
        scheduleClaimedAt?.getTime(),
      );
    } finally {
      if (activeClaim) {
        await releaseCustomAutomationLaunchClaim(created.id, activeClaim);
      }
      await deleteCustomAutomation(created.id);
    }
  });

  it('rejects a partially specified report destination', async () => {
    await expect(
      createCustomAutomation({
        name: `Partial target ${Date.now()}`,
        prompt: 'Scan for flaky tests.',
        enabled: true,
        scheduleMode: 'daily',
        environmentId: 'ignored-by-early-validation',
        target: { provider: 'slack' } as never,
      }),
    ).rejects.toThrow('Report destination');
  });
});
