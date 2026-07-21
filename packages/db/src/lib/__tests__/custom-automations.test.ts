import { describe, expect, it } from 'vitest';

import {
  createCustomAutomation,
  deleteCustomAutomation,
  getCustomAutomationById,
  listCustomAutomations,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
  updateCustomAutomation,
} from '../custom-automations';
import { RunStatus } from '@roomote/types';

import {
  customAutomations,
  db,
  environments,
  eq,
  runFactory,
  taskFactory,
} from '../../server';

describe('custom automations helpers', () => {
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

  it('gates scheduled claims on active runs and lets manual claims bypass', async () => {
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

    // A sleeping previous task (still state='active' for snapshot resume,
    // but its run completed) must not block the next scheduled launch.
    const sleepingTask = await taskFactory.create({ state: 'active' });
    await runFactory.create({
      taskId: sleepingTask.id,
      status: RunStatus.Completed,
    });
    await db
      .update(customAutomations)
      .set({ lastLaunchedTaskId: sleepingTask.id })
      .where(eq(customAutomations.id, created.id));

    const claimPastSleepingTask = await tryClaimCustomAutomationLaunch(
      created.id,
    );
    expect(claimPastSleepingTask).toBeInstanceOf(Date);
    await releaseCustomAutomationLaunchClaim(
      created.id,
      claimPastSleepingTask!,
    );

    // A previous task with a genuinely active run blocks scheduled claims.
    const runningTask = await taskFactory.create({ state: 'active' });
    await runFactory.create({
      taskId: runningTask.id,
      status: RunStatus.Running,
    });
    await db
      .update(customAutomations)
      .set({ lastLaunchedTaskId: runningTask.id })
      .where(eq(customAutomations.id, created.id));

    expect(await tryClaimCustomAutomationLaunch(created.id)).toBeNull();

    // A manual claim launches despite the active run.
    const manualClaim = await tryClaimCustomAutomationLaunch(created.id, {
      allowWhilePreviousRunActive: true,
    });
    expect(manualClaim).toBeInstanceOf(Date);

    // The claim fence still guards concurrent launches, manual included.
    expect(
      await tryClaimCustomAutomationLaunch(created.id, {
        allowWhilePreviousRunActive: true,
      }),
    ).toBeNull();

    await releaseCustomAutomationLaunchClaim(created.id, manualClaim!);
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
