import { and, eq, inArray } from 'drizzle-orm';

import {
  cloudJobs,
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
  await db.delete(cloudJobs).where(inArray(cloudJobs.taskId, demoTaskIds));
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
      // user + installation + environment + repositories + tasks + cloud jobs
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
      expect(task?.userId).toBe(demoSeedUserId);
      expect(task?.attributedUserId).toBe(demoSeedUserId);
      expect(task?.title).toBe(seedTask.title);

      const cloudJob = await db.query.cloudJobs.findFirst({
        where: eq(cloudJobs.taskId, seedTask.id),
      });
      expect(cloudJob).toBeDefined();
      expect(cloudJob?.status).toBe(seedTask.cloudJobStatus);
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

    const seededCloudJobs = await db.query.cloudJobs.findMany({
      where: inArray(cloudJobs.taskId, demoTaskIds),
    });
    expect(seededCloudJobs).toHaveLength(demoSeedTasks.length);
  });
});
