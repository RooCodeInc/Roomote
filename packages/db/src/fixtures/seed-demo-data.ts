import { and, eq } from 'drizzle-orm';

import { ACP_ENVELOPE_EVENT_TYPES, RunStatus } from '@roomote/types';

import type { CreateUser } from '../types';
import {
  taskRuns,
  deploymentSettings,
  environments,
  fastAgentConversations,
  fastAgentMessages,
  githubInstallations,
  repositories,
  sessionParticipants,
  sessions,
  tasks,
  taskPullRequests,
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

export const demoSeedFastSession = {
  conversationId: '00000000-0000-4000-8000-000000000101',
  sessionId: '00000000-0000-4000-8000-000000000102',
  participantId: '00000000-0000-4000-8000-000000000103',
  title: 'Summarize launch readiness',
  workspaceId: 'TROOMOTEDEMO',
  providerConversationId: 'demo-fast-session',
  channelId: 'CROOMOTEDEMO',
  threadId: '1700000000.000100',
  messages: [
    {
      id: '00000000-0000-4000-8000-000000000104',
      eventId: 'demo-fast-session-user-prompt',
      turnId: 'demo-fast-session-turn',
      turnSeq: 0,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user' as const,
      text: 'Summarize the launch readiness review and call out any blockers.',
    },
    {
      id: '00000000-0000-4000-8000-000000000105',
      eventId: 'demo-fast-session-assistant-message',
      turnId: 'demo-fast-session-turn',
      turnSeq: 1,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant' as const,
      text: 'The launch checklist is complete. Authentication, billing, and rollback checks passed, and there are no open blockers.',
    },
  ],
} as const;

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

export const demoSeedPullRequests = [
  {
    taskId: 'demo-seed-task-fix-login',
    repository: 'roomote-demo/demo-web',
    prNumber: 101,
    prUrl: 'https://github.com/roomote-demo/demo-web/pull/101',
    prTitle: 'Fix expired-session redirect handling',
    status: 'open',
  },
  {
    taskId: 'demo-seed-task-add-webhooks',
    repository: 'roomote-demo/demo-api',
    prNumber: 201,
    prUrl: 'https://github.com/roomote-demo/demo-api/pull/201',
    prTitle: 'Add webhook retry policy',
    status: 'draft',
  },
  {
    taskId: 'demo-seed-task-add-webhooks',
    repository: 'roomote-demo/demo-web',
    prNumber: 202,
    prUrl: 'https://github.com/roomote-demo/demo-web/pull/202',
    prTitle: 'Show webhook retry status',
    status: 'open',
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
 * also marks setup as complete so a seeded app is not gated behind /setup.
 *
 * Every entity is keyed by a stable identifier and only inserted when missing,
 * so the seed is safe to re-run on every sandbox boot or preview deploy.
 * Existing demo rows are not overwritten; missing setup and task-run lifecycle
 * fields from older seed versions are backfilled in place.
 */
export async function seedDemoData(): Promise<DemoSeedSummary> {
  const summary: DemoSeedSummary = { created: [], skipped: [] };

  const record = (label: string, created: boolean) => {
    (created ? summary.created : summary.skipped).push(label);
  };

  const now = new Date();

  // Deployment settings. The web app gates everything behind /setup until the
  // singleton settings row has `setupCompletedAt`, so a seeded sandbox gets
  // setup marked complete. Repair an incomplete singleton left by an earlier
  // sandbox boot while preserving every other setting.
  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
  });
  const setupIncomplete = existingSettings?.setupCompletedAt == null;

  if (!existingSettings) {
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', setupCompletedAt: now });
  } else if (setupIncomplete) {
    await db
      .update(deploymentSettings)
      .set({ setupCompletedAt: now })
      .where(eq(deploymentSettings.id, 'default'));
  }

  record('deployment settings default', !existingSettings || setupIncomplete);

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

  // A complete Fast Session keeps the standard seed useful for validating the
  // canonical Session detail route, transcript, and Slack origin metadata.
  const existingFastConversation =
    await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, demoSeedFastSession.conversationId),
    });

  if (!existingFastConversation) {
    await db.insert(fastAgentConversations).values({
      id: demoSeedFastSession.conversationId,
      userId: demoSeedUserId,
      surface: 'slack',
      workspaceId: demoSeedFastSession.workspaceId,
      conversationId: demoSeedFastSession.providerConversationId,
      currentReplyChannelId: demoSeedFastSession.channelId,
      currentReplyThreadId: demoSeedFastSession.threadId,
      replyTargetVerified: true,
      title: demoSeedFastSession.title,
      llmTitleCheckpoint: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  record('Fast conversation demo', !existingFastConversation);

  for (const [index, message] of demoSeedFastSession.messages.entries()) {
    const existingMessage = await db.query.fastAgentMessages.findFirst({
      where: eq(fastAgentMessages.id, message.id),
    });

    if (!existingMessage) {
      await db.insert(fastAgentMessages).values({
        id: message.id,
        conversationId: demoSeedFastSession.conversationId,
        eventId: message.eventId,
        turnId: message.turnId,
        turnSeq: message.turnSeq,
        ts:
          now.getTime() - (demoSeedFastSession.messages.length - index) * 1_000,
        eventType: message.eventType,
        role: message.role,
        contentBlocks: [{ type: 'text', text: message.text }],
        metadata: {
          visibleInTranscript: true,
          ...(message.role === 'user' ? { userId: demoSeedUserId } : {}),
        },
        payload: {},
        source: 'slack',
        createdAt: now,
        updatedAt: now,
      });
    }

    record(`Fast message ${message.eventId}`, !existingMessage);
  }

  let fastSession = await db.query.sessions.findFirst({
    where: eq(sessions.fastConversationId, demoSeedFastSession.conversationId),
  });
  const fastSessionCreated = !fastSession;

  if (!fastSession) {
    [fastSession] = await db
      .insert(sessions)
      .values({
        id: demoSeedFastSession.sessionId,
        title: demoSeedFastSession.title,
        llmTitleCheckpoint: 1,
        ownerKind: 'user',
        ownerUserId: demoSeedUserId,
        sourceSurface: 'slack',
        sourceTrigger: 'message',
        fastConversationId: demoSeedFastSession.conversationId,
        visibility: 'visible',
        activityAt: Math.floor(now.getTime() / 1_000),
        cachedStatus: 'ready',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }

  if (!fastSession) {
    throw new Error('Failed to seed the canonical Fast Session');
  }

  record('Session for Fast conversation demo', fastSessionCreated);

  const existingFastSessionParticipant =
    await db.query.sessionParticipants.findFirst({
      where: and(
        eq(sessionParticipants.sessionId, fastSession.id),
        eq(sessionParticipants.userId, demoSeedUserId),
      ),
    });

  if (!existingFastSessionParticipant) {
    await db.insert(sessionParticipants).values({
      id: demoSeedFastSession.participantId,
      sessionId: fastSession.id,
      userId: demoSeedUserId,
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
  }

  record(
    'owner participant for Fast conversation demo',
    !existingFastSessionParticipant,
  );

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

    let taskRunChanged = !existingTaskRun;

    if (!existingTaskRun) {
      await runFactory.create({
        taskId: task.id,
        actingUserId: demoSeedUserId,
        status: task.taskRunStatus,
        startedAt: now,
        completedAt:
          task.taskRunStatus === RunStatus.Completed ? now : undefined,
        payload: {
          repo: task.repositoryFullName,
          description: task.title,
        },
      });
    } else {
      const lifecycleBackfill = {
        ...(existingTaskRun.startedAt == null ? { startedAt: now } : {}),
        ...(existingTaskRun.status === RunStatus.Completed &&
        existingTaskRun.completedAt == null
          ? { completedAt: now }
          : {}),
      };

      if (Object.keys(lifecycleBackfill).length > 0) {
        await db
          .update(taskRuns)
          .set(lifecycleBackfill)
          .where(eq(taskRuns.id, existingTaskRun.id));
        taskRunChanged = true;
      }
    }

    record(`task run for ${task.id}`, taskRunChanged);
  }

  // A single-PR task and a split task keep the seeded dashboard useful for
  // exercising task-level PR presentation without requiring remote GitHub data.
  for (const pullRequest of demoSeedPullRequests) {
    const existingPullRequest = await db.query.taskPullRequests.findFirst({
      where: and(
        eq(taskPullRequests.taskId, pullRequest.taskId),
        eq(taskPullRequests.prUrl, pullRequest.prUrl),
      ),
    });

    if (!existingPullRequest) {
      await db.insert(taskPullRequests).values({
        taskId: pullRequest.taskId,
        sourceControlProvider: 'github',
        host: 'github.com',
        prUrl: pullRequest.prUrl,
        prNumber: pullRequest.prNumber,
        prTitle: pullRequest.prTitle,
        repository: pullRequest.repository,
        status: pullRequest.status,
      });
    }

    record(`pull request ${pullRequest.prUrl}`, !existingPullRequest);
  }

  return summary;
}
