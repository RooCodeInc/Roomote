import { and, eq } from 'drizzle-orm';

import { RunStatus } from '@roomote/types';

import type { CreateUser } from '../types';
import {
  taskRuns,
  deploymentSettings,
  environments,
  githubInstallations,
  repositories,
  tasks,
  users,
} from '../schema';
import { db } from '../db';

import {
  runFactory,
  environmentFactory,
  githubInstallationFactory,
  repositoryFactory,
  taskFactory,
  userFactory,
} from './factories';

export const demoSeedUserId = 'demo-seed-user';
const demoSeedUserEmail = 'demo@roomote.dev';
const demoSeedGithubAccountLogin = 'roomote-demo';
export const demoSeedEnvironmentName = 'Roomote Demo Environment';

export const demoSeedRepositories = [
  {
    fullName: 'roomote-demo/demo-web',
    name: 'demo-web',
    githubRepoId: 900_000_001,
  },
  {
    fullName: 'roomote-demo/demo-api',
    name: 'demo-api',
    githubRepoId: 900_000_002,
  },
] as const;

export const demoSeedTasks = [
  {
    id: 'demo-seed-task-fix-login',
    title: 'Fix login redirect loop on expired sessions',
    mode: 'code',
    state: 'completed',
    taskRunStatus: RunStatus.Completed,
    repositoryFullName: 'roomote-demo/demo-web',
  },
  {
    id: 'demo-seed-task-add-webhooks',
    title: 'Add webhook retries with exponential backoff',
    mode: 'code',
    state: 'completed',
    taskRunStatus: RunStatus.Completed,
    repositoryFullName: 'roomote-demo/demo-api',
  },
  {
    id: 'demo-seed-task-explain-auth',
    title: 'Explain how session tokens are validated',
    mode: 'ask',
    state: 'active',
    taskRunStatus: RunStatus.Running,
    repositoryFullName: 'roomote-demo/demo-api',
  },
] as const;

interface DemoSeedSummary {
  created: string[];
  skipped: string[];
}

/**
 * Inserts a small, stable set of demo data (a demo user, GitHub installation,
 * repositories, an environment, and a few tasks with task runs) so task
 * sandboxes and preview deployments do not start from an empty dashboard. It
 * also marks setup as complete when the deployment settings row is missing so
 * a freshly seeded app is not gated behind /setup.
 *
 * Every entity is keyed by a stable identifier and only inserted when missing,
 * so the seed is safe to re-run on every sandbox boot or preview deploy.
 * Existing rows are never updated or deleted.
 */
export async function seedDemoData(): Promise<DemoSeedSummary> {
  const summary: DemoSeedSummary = { created: [], skipped: [] };

  const record = (label: string, created: boolean) => {
    (created ? summary.created : summary.skipped).push(label);
  };

  const now = new Date();

  // Deployment settings. The web app gates everything behind /setup until the
  // singleton settings row has `setupCompletedAt`, so a freshly seeded
  // database also gets setup marked complete. An existing row is never
  // touched so real setup state is preserved.
  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
  });

  if (!existingSettings) {
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', setupCompletedAt: now });
  }

  record('deployment settings default', !existingSettings);

  // Demo user.
  const demoUser: CreateUser = {
    id: demoSeedUserId,
    name: 'Roomote Demo',
    email: demoSeedUserEmail,
    imageUrl: '',
    entity: {
      id: demoSeedUserId,
      name: 'Roomote Demo',
      email: demoSeedUserEmail,
      imageUrl: '',
    },
    metadata: {},
    onboardingCompletedAt: now,
  };

  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, demoSeedUserId),
  });

  if (!existingUser) {
    await userFactory.create(demoUser);
  }

  record(`user ${demoSeedUserId}`, !existingUser);

  // Demo GitHub installation owned by the demo user.
  let installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installedByUserId, demoSeedUserId),
  });

  if (!installation) {
    installation = await githubInstallationFactory.create({
      installedByUserId: demoSeedUserId,
      accountLogin: demoSeedGithubAccountLogin,
      accountType: 'Organization',
    });
    record(`github installation ${demoSeedGithubAccountLogin}`, true);
  } else {
    record(`github installation ${demoSeedGithubAccountLogin}`, false);
  }

  // Demo repositories linked through the demo installation.
  for (const repo of demoSeedRepositories) {
    const existingRepository = await db.query.repositories.findFirst({
      where: and(
        eq(repositories.sourceControlProvider, 'github'),
        eq(repositories.fullName, repo.fullName),
      ),
    });

    if (!existingRepository) {
      await repositoryFactory.create({
        installationId: installation.id,
        linkedByUserId: demoSeedUserId,
        fullName: repo.fullName,
        name: repo.name,
        githubRepoId: repo.githubRepoId,
      });
    }

    record(`repository ${repo.fullName}`, !existingRepository);
  }

  // Demo environment pointing at the demo repositories.
  const existingEnvironment = await db.query.environments.findFirst({
    where: and(
      eq(environments.createdByUserId, demoSeedUserId),
      eq(environments.name, demoSeedEnvironmentName),
    ),
  });

  if (!existingEnvironment) {
    await environmentFactory.create({
      createdByUserId: demoSeedUserId,
      name: demoSeedEnvironmentName,
      description: 'Demo environment seeded for sandbox and preview runs',
      config: {
        name: demoSeedEnvironmentName,
        repositories: demoSeedRepositories.map(({ fullName }) => ({
          repository: fullName,
        })),
      },
    });
  }

  record(`environment ${demoSeedEnvironmentName}`, !existingEnvironment);

  // Demo tasks in a few representative states. Each task gets a matching
  // task_run because the task-history views only render tasks that have at
  // least one run, and initiatorUserId so the tasks show up under the demo
  // user's initiator filter.
  for (const task of demoSeedTasks) {
    const existingTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    if (!existingTask) {
      await taskFactory.create({
        id: task.id,
        initiatorUserId: demoSeedUserId,
        title: task.title,
        mode: task.mode,
        state: task.state,
        repositoryName: task.repositoryFullName,
        repositoryUrl: `https://github.com/${task.repositoryFullName}`,
        defaultBranch: 'main',
      });
    }

    record(`task ${task.id}`, !existingTask);

    const existingTaskRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, task.id),
    });

    if (!existingTaskRun) {
      await runFactory.create({
        taskId: task.id,
        actingUserId: demoSeedUserId,
        status: task.taskRunStatus,
        payload: {
          repo: task.repositoryFullName,
          description: task.title,
        },
      });
    }

    record(`task run for ${task.id}`, !existingTaskRun);
  }

  return summary;
}
