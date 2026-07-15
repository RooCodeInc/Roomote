import {
  db,
  environmentFactory,
  runFactory,
  taskFactory,
  taskRuns,
  eq,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import { getActiveVerificationTaskIdForTest } from './index';

describe('getActiveVerificationTaskId', () => {
  async function createEnvironment() {
    return environmentFactory.create({ createdByUserId: null });
  }

  async function createActiveRun(params: {
    taskId: string;
    payload: Record<string, unknown>;
  }) {
    const run = await runFactory.create({
      taskId: params.taskId,
      payload: params.payload as never,
    });
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Running })
      .where(eq(taskRuns.id, run.id));
    return run;
  }

  it('detects an active retry verification task (verifiesEnvironmentId marker)', async () => {
    const environment = await createEnvironment();
    const task = await taskFactory.create({ workflow: 'standard' });
    await createActiveRun({
      taskId: task.id,
      payload: {
        repo: 'test/repo',
        verifiesEnvironmentId: environment.id,
        description: 'verify',
      },
    });

    await expect(
      getActiveVerificationTaskIdForTest(db, environment.id),
    ).resolves.toBe(task.id);
  });

  it('detects an active initial onboarding verification (setup_onboarding + environmentDefinitionId)', async () => {
    const environment = await createEnvironment();
    const task = await taskFactory.create({ workflow: 'setup_onboarding' });
    await createActiveRun({
      taskId: task.id,
      payload: {
        repo: 'test/repo',
        environmentDefinitionId: environment.id,
        description: 'setup + verify',
      },
    });

    // A stale retry must not be able to supersede an in-flight onboarding
    // verification.
    await expect(
      getActiveVerificationTaskIdForTest(db, environment.id),
    ).resolves.toBe(task.id);
  });

  it('ignores a setup task for a different environment', async () => {
    const environment = await createEnvironment();
    const otherEnvironment = await createEnvironment();
    const task = await taskFactory.create({ workflow: 'setup_onboarding' });
    await createActiveRun({
      taskId: task.id,
      payload: {
        repo: 'test/repo',
        environmentDefinitionId: otherEnvironment.id,
        description: 'setup + verify',
      },
    });

    await expect(
      getActiveVerificationTaskIdForTest(db, environment.id),
    ).resolves.toBeNull();
  });

  it('does not treat an environmentDefinitionId marker on a non-setup workflow as an active verification', async () => {
    const environment = await createEnvironment();
    const task = await taskFactory.create({ workflow: 'standard' });
    await createActiveRun({
      taskId: task.id,
      payload: {
        repo: 'test/repo',
        environmentDefinitionId: environment.id,
        description: 'unrelated standard task',
      },
    });

    await expect(
      getActiveVerificationTaskIdForTest(db, environment.id),
    ).resolves.toBeNull();
  });

  it('returns null when no active verification task exists', async () => {
    const environment = await createEnvironment();

    await expect(
      getActiveVerificationTaskIdForTest(db, environment.id),
    ).resolves.toBeNull();
  });
});
