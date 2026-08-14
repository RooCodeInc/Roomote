import { describe, expect, it } from 'vitest';
import { ALL_REPOSITORIES } from '@roomote/types';

import {
  createCustomAutomation,
  deleteCustomAutomation,
  getCustomAutomationById,
  listCustomAutomations,
  listRecentCustomAutomationTaskRuns,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
  updateCustomAutomation,
} from '../custom-automations';
import {
  customAutomations,
  db,
  environments,
  ensureAutomationRows,
  eq,
  taskFactory,
} from '../../server';

describe('custom automations helpers', () => {
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

  it('lists recent tasks for one custom automation', async () => {
    await ensureAutomationRows();
    const automationId = `automation-run-history-${Date.now()}`;
    const createdRuns = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        taskFactory.create({
          initiatorKind: 'automation',
          initiatorAutomation: 'custom_automation',
          initiatorUserId: null,
          actorExternalId: automationId,
          title: `Run ${index + 1}`,
          state: index === 5 ? 'failed' : 'completed',
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        }),
      ),
    );
    await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'custom_automation',
      initiatorUserId: null,
      actorExternalId: '22222222-2222-2222-2222-222222222222',
      title: 'Other automation run',
    });

    const runs = await listRecentCustomAutomationTaskRuns(automationId);

    expect(runs.map((run) => run.taskId)).toEqual(
      createdRuns
        .slice(1)
        .reverse()
        .map((run) => run.id),
    );
    expect(runs[0]).toMatchObject({
      title: 'Run 6',
      state: 'failed',
      trigger: 'manual',
    });
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

  it('persists a model override and rejects malformed model ids', async () => {
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
      environmentId: environment!.id,
      target: {},
    });
    expect(created.model).toBe('anthropic/claude-sonnet-5');

    const cleared = await updateCustomAutomation(created.id, {
      name: created.name,
      prompt: created.prompt,
      enabled: true,
      scheduleMode: 'daily',
      model: null,
      environmentId: environment!.id,
      target: {},
    });
    expect(cleared.model).toBeNull();

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
