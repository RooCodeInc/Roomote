import { and, eq, inArray } from 'drizzle-orm';

import {
  taskRuns,
  deploymentSettings,
  environments,
  githubInstallations,
  repositories,
  tasks,
  users,
} from '../../schema';
import { db } from '../../db';
import {
  demoSeedEnvironmentName,
  demoSeedRepositories,
  demoSeedTasks,
  demoSeedUserId,
  seedDemoData,
} from '../seed-demo-data';

const demoTaskIds = demoSeedTasks.map(({ id }) => id);

// The deployment settings row is a shared singleton in the test database, so
// the assertions below ignore it and cleanup only removes it when this suite
// created it.
let settingsExistedBefore = false;

function withoutSettings(labels: string[]) {
  return labels.filter((label) => !label.startsWith('deployment settings'));
}

async function cleanup() {
  await db.delete(taskRuns).where(inArray(taskRuns.taskId, demoTaskIds));
  await db.delete(tasks).where(inArray(tasks.id, demoTaskIds));
  await db
    .delete(environments)
    .where(eq(environments.createdByUserId, demoSeedUserId));
  await db.delete(repositories).where(
    inArray(
      repositories.fullName,
      demoSeedRepositories.map(({ fullName }) => fullName),
    ),
  );
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.installedByUserId, demoSeedUserId));
  await db.delete(users).where(eq(users.id, demoSeedUserId));
}

describe('seedDemoData', () => {
  beforeAll(async () => {
    settingsExistedBefore = Boolean(
      await db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
      }),
    );
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!settingsExistedBefore) {
      await db
        .delete(deploymentSettings)
        .where(eq(deploymentSettings.id, 'default'));
    }
  });

  it('inserts the demo data set when missing', async () => {
    const summary = await seedDemoData();

    expect(withoutSettings(summary.skipped)).toEqual([]);
    expect(withoutSettings(summary.created)).toHaveLength(
      // user + installation + environment + repositories + tasks + task runs
      3 + demoSeedRepositories.length + demoSeedTasks.length * 2,
    );

    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
    expect(settings).toBeDefined();

    const user = await db.query.users.findFirst({
      where: eq(users.id, demoSeedUserId),
    });
    expect(user).toBeDefined();
    expect(user?.onboardingCompletedAt).not.toBeNull();

    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installedByUserId, demoSeedUserId),
    });
    expect(installation).toBeDefined();

    for (const repo of demoSeedRepositories) {
      const repository = await db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, 'github'),
          eq(repositories.fullName, repo.fullName),
        ),
      });
      expect(repository).toBeDefined();
      expect(repository?.installationId).toBe(installation?.id);
    }

    const environment = await db.query.environments.findFirst({
      where: and(
        eq(environments.createdByUserId, demoSeedUserId),
        eq(environments.name, demoSeedEnvironmentName),
      ),
    });
    expect(environment).toBeDefined();
    expect(environment?.config.repositories).toHaveLength(
      demoSeedRepositories.length,
    );

    for (const seedTask of demoSeedTasks) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, seedTask.id),
      });
      expect(task).toBeDefined();
      expect(task?.initiatorKind).toBe('user');
      expect(task?.initiatorUserId).toBe(demoSeedUserId);
      expect(task?.title).toBe(seedTask.title);

      const taskRun = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, seedTask.id),
      });
      expect(taskRun).toBeDefined();
      expect(taskRun?.status).toBe(seedTask.taskRunStatus);
    }
  });

  it('is idempotent and leaves existing rows untouched on re-run', async () => {
    await seedDemoData();

    const userBefore = await db.query.users.findFirst({
      where: eq(users.id, demoSeedUserId),
    });

    const summary = await seedDemoData();

    expect(summary.created).toEqual([]);
    expect(withoutSettings(summary.skipped)).toHaveLength(
      3 + demoSeedRepositories.length + demoSeedTasks.length * 2,
    );

    const userAfter = await db.query.users.findFirst({
      where: eq(users.id, demoSeedUserId),
    });
    expect(userAfter?.updatedAt).toEqual(userBefore?.updatedAt);

    const seededTasks = await db.query.tasks.findMany({
      where: inArray(tasks.id, demoTaskIds),
    });
    expect(seededTasks).toHaveLength(demoSeedTasks.length);

    const seededTaskRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.taskId, demoTaskIds),
    });
    expect(seededTaskRuns).toHaveLength(demoSeedTasks.length);
  });
});
