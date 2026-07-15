import { Hono } from 'hono';

import {
  type AuthTokenContext,
  TaskPayloadKind,
  type RunTokenContext,
} from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { submitAutomationWorkItems } from '../submitAutomationWorkItems';

const {
  mockTaskRunFindFirst,
  mockLaunchActWorkItems,
  mockPersistAutomationWorkItems,
  mockResolveAutomationSlackTarget,
  mockResolvePreparedAutomationWorkItems,
  mockResolveRepositoryIdsForSuggestedTask,
  mockTaskFindFirst,
} = vi.hoisted(() => ({
  mockTaskRunFindFirst: vi.fn(),
  mockLaunchActWorkItems: vi.fn(),
  mockPersistAutomationWorkItems: vi.fn(),
  mockResolveAutomationSlackTarget: vi.fn(),
  mockResolvePreparedAutomationWorkItems: vi.fn(),
  mockResolveRepositoryIdsForSuggestedTask: vi.fn(),
  mockTaskFindFirst: vi.fn(),
}));

vi.mock('../automation-work-items/telegram.js', () => ({
  resolveAutomationTelegramTarget: vi.fn(async () => null),
  postLateBoundWorkItemFailureToTelegram: vi.fn(async () => undefined),
}));

vi.mock('../automation-work-items/teams.js', () => ({
  resolveAutomationTeamsTarget: vi.fn(async () => null),
  postLateBoundWorkItemFailureToTeams: vi.fn(async () => undefined),
}));

vi.mock('../automation-work-items/discord.js', () => ({
  resolveAutomationDiscordTarget: vi.fn(async () => null),
  postLateBoundWorkItemFailureToDiscord: vi.fn(async () => undefined),
}));

vi.mock('@roomote/db/server', () => ({
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: null,
    webhookSecret: null,
    botUsername: null,
  })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  taskRuns: {
    taskId: 'taskRuns.taskId',
  },
  tasks: {
    id: 'tasks.id',
  },
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunFindFirst(...args),
      },
      tasks: {
        findFirst: (...args: unknown[]) => mockTaskFindFirst(...args),
      },
    },
  },
  eq: vi.fn((...args) => ({ type: 'eq', args })),
}));

vi.mock('../automation-work-items/launch.js', () => ({
  launchActWorkItems: (...args: unknown[]) => mockLaunchActWorkItems(...args),
}));

vi.mock('../automation-work-items/persistence.js', () => ({
  persistAutomationWorkItems: (...args: unknown[]) =>
    mockPersistAutomationWorkItems(...args),
  loadRelaunchableDuplicateWorkItems: vi.fn(async () => []),
}));

vi.mock('../automation-work-items/prepare.js', () => ({
  AutomationWorkItemValidationError: class AutomationWorkItemValidationError extends Error {},
  resolvePreparedAutomationWorkItems: (...args: unknown[]) =>
    mockResolvePreparedAutomationWorkItems(...args),
}));

vi.mock('../automation-work-items/repositories.js', () => ({
  resolveRepositoryIdsForSuggestedTask: (...args: unknown[]) =>
    mockResolveRepositoryIdsForSuggestedTask(...args),
}));

vi.mock('../automation-work-items/slack.js', () => ({
  resolveAutomationSlackTarget: (...args: unknown[]) =>
    mockResolveAutomationSlackTarget(...args),
}));

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/tasks/:taskId/automation_work_items', submitAutomationWorkItems);

  return app;
}

function buildActWorkItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'act-work-item-1',
    title: 'Fix parser nil access',
    brief: 'Nil access is driving a production Sentry issue.',
    category: 'bug',
    priority: 'P1',
    actionKind: 'code_change_pr',
    disposition: 'act',
    status: 'open',
    investigationContext: '$sentry-triage\nIssue: SENTRY-123',
    executionPrompt:
      'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
    fingerprint: 'fingerprint-1',
    repositoryIds: ['repo-1'],
    targetRepositoryFullName: 'acme/app',
    targetEnvironmentId: '11111111-1111-1111-1111-111111111111',
    workspaceReadiness: 'environment_backed',
    readinessMessage: null,
    sortOrder: 0,
    launchedTaskId: null,
    launchError: null,
    ...overrides,
  };
}

describe('submitAutomationWorkItems lifecycle', () => {
  const authContext: RunTokenContext = {
    userId: 'user-1',
    principal: 'user',
    runId: 1,
    tokenType: 'run',
    version: 1,
  };

  beforeEach(() => {
    mockTaskFindFirst.mockReset();
    mockTaskRunFindFirst.mockReset();
    mockLaunchActWorkItems.mockReset();
    mockPersistAutomationWorkItems.mockReset();
    mockResolveAutomationSlackTarget.mockReset();
    mockResolvePreparedAutomationWorkItems.mockReset();
    mockResolveRepositoryIdsForSuggestedTask.mockReset();

    mockTaskRunFindFirst.mockResolvedValue({
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        suggestionSource: 'sentry_triage',
      },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: null,
      initiatorAutomation: 'sentry_triage',
    });
    mockResolveRepositoryIdsForSuggestedTask.mockResolvedValue([
      { id: 'repo-1', fullName: 'acme/app' },
    ]);
    mockResolvePreparedAutomationWorkItems.mockResolvedValue([
      { title: 'Fix parser nil access' },
    ]);
    mockResolveAutomationSlackTarget.mockResolvedValue({
      channelId: 'C123',
      slack: { postMessage: vi.fn() },
    });
    mockLaunchActWorkItems.mockResolvedValue({
      launchedCount: 1,
      failedCount: 0,
    });
  });

  it('launches a silent late-bound execution task for a Sentry act work item', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    const actWorkItem = buildActWorkItem({
      targetEnvironmentId: environmentId,
      workspaceReadiness: 'environment_backed',
      readinessMessage: null,
    });
    mockPersistAutomationWorkItems.mockResolvedValueOnce({
      created: true,
      duplicateCount: 0,
      duplicateWorkItemRefs: [],
      workItems: [actWorkItem],
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a production Sentry issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      workItemCount: 1,
      actedCount: 1,
      launchedCount: 1,
      failedCount: 0,
      duplicateCount: 0,
    });
    expect(mockLaunchActWorkItems).toHaveBeenCalledWith({
      // The launch is stamped with the originating automation's key instead
      // of a config-owner userId.
      automationKey: 'sentry_triage',
      workItems: [actWorkItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: expect.objectContaining({
        provider: 'slack',
        channelId: 'C123',
      }),
    });
  });

  it('relaunches launchable act items when a persisted batch is resubmitted', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    const actWorkItem = buildActWorkItem();
    const startedWorkItem = buildActWorkItem({
      id: 'act-work-item-2',
      status: 'launched',
      launchedTaskId: 'task-123',
      fingerprint: 'fingerprint-2',
      targetEnvironmentId: environmentId,
    });
    mockPersistAutomationWorkItems.mockResolvedValueOnce({
      created: false,
      duplicateCount: 0,
      duplicateWorkItemRefs: [],
      workItems: [actWorkItem, startedWorkItem],
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a production Sentry issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      workItemCount: 2,
      actedCount: 2,
      launchedCount: 1,
      failedCount: 0,
      duplicateCount: 0,
    });
    // Only the still-launchable item relaunches; the started one is skipped.
    expect(mockLaunchActWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        workItems: [actWorkItem],
      }),
    );
  });

  it('skips Slack target resolution when nothing is launchable', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    mockPersistAutomationWorkItems.mockResolvedValueOnce({
      created: true,
      duplicateCount: 1,
      duplicateWorkItemRefs: [
        { id: 'act-work-item-1', fingerprint: 'fingerprint-1' },
      ],
      workItems: [],
    });
    mockLaunchActWorkItems.mockResolvedValueOnce({
      launchedCount: 0,
      failedCount: 0,
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a production Sentry issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      workItemCount: 0,
      actedCount: 0,
      launchedCount: 0,
      failedCount: 0,
      duplicateCount: 1,
    });
    expect(mockResolveAutomationSlackTarget).not.toHaveBeenCalled();
    expect(mockLaunchActWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        workItems: [],
        chatTarget: null,
      }),
    );
  });

  it('launches multiple Dependabot act items with environment-backed validation', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    const secondEnvironmentId = '22222222-2222-2222-2222-222222222222';
    const actWorkItem = buildActWorkItem({
      title: 'Update braces to resolve Dependabot alert',
      investigationContext: '$update-dependencies\nAlert: GHSA-123',
      executionPrompt:
        '$update-dependencies\nRe-verify the alert, apply the update, validate, and open a PR.',
      targetEnvironmentId: environmentId,
      workspaceReadiness: 'environment_backed',
      readinessMessage: null,
      category: 'security',
    });
    const secondActWorkItem = buildActWorkItem({
      id: 'act-work-item-2',
      title: 'Update ws to resolve Dependabot alert',
      investigationContext: '$update-dependencies\nAlert: GHSA-456',
      executionPrompt:
        '$update-dependencies\nRe-verify the ws alert, apply the update, validate, and open a PR.',
      fingerprint: 'fingerprint-2',
      targetEnvironmentId: secondEnvironmentId,
      workspaceReadiness: 'environment_backed',
      readinessMessage: null,
      category: 'security',
    });
    mockTaskRunFindFirst.mockResolvedValueOnce({
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        suggestionSource: 'dependabot_triage',
      },
    });
    mockTaskFindFirst.mockResolvedValueOnce({
      initiatorUserId: null,
      initiatorAutomation: 'dependabot_triage',
    });
    mockResolvePreparedAutomationWorkItems.mockResolvedValueOnce([
      { title: 'Update braces to resolve Dependabot alert' },
      { title: 'Update ws to resolve Dependabot alert' },
    ]);
    mockLaunchActWorkItems.mockResolvedValueOnce({
      launchedCount: 2,
      failedCount: 0,
    });
    mockPersistAutomationWorkItems.mockResolvedValueOnce({
      created: true,
      duplicateCount: 0,
      duplicateWorkItemRefs: [],
      workItems: [actWorkItem, secondActWorkItem],
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Update braces to resolve Dependabot alert',
              brief:
                'Apply the narrowest safe update and validate the affected flow.',
              category: 'security',
              priority: 'P1',
              actionKind: 'code_change_pr',
              disposition: 'act',
              investigationContext: '$update-dependencies\nAlert: GHSA-123',
              executionPrompt:
                '$update-dependencies\nRe-verify the alert, apply the update, validate, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
            {
              title: 'Update ws to resolve Dependabot alert',
              brief:
                'Apply the narrowest safe ws update and validate the worker flow.',
              category: 'security',
              priority: 'P1',
              actionKind: 'code_change_pr',
              disposition: 'act',
              investigationContext: '$update-dependencies\nAlert: GHSA-456',
              executionPrompt:
                '$update-dependencies\nRe-verify the ws alert, apply the update, validate, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: secondEnvironmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      workItemCount: 2,
      actedCount: 2,
      launchedCount: 2,
      failedCount: 0,
      duplicateCount: 0,
    });
    expect(mockLaunchActWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTaskBootstrap: '$update-dependencies',
        chatTarget: expect.objectContaining({
          provider: 'slack',
          channelId: 'C123',
        }),
        workItems: [actWorkItem, secondActWorkItem],
      }),
    );
  });

  it.each([
    { source: 'security_auditor' as const },
    { source: 'code_quality_auditor' as const },
  ])(
    'launches $source act items with required environment-backed launches',
    async ({ source }) => {
      const environmentId = '11111111-1111-1111-1111-111111111111';
      const actWorkItem = buildActWorkItem({
        investigationContext: `$${source.replaceAll('_', '-')}\nPR: acme/app#42`,
        targetEnvironmentId: environmentId,
        workspaceReadiness: 'environment_backed',
        readinessMessage: null,
      });
      mockTaskRunFindFirst.mockResolvedValueOnce({
        payloadKind: TaskPayloadKind.Scan,
        actingUserId: 'user-1',
        payload: {
          repo: 'acme/app',
          selectedRepositories: ['acme/app'],
          suggestionSource: source,
        },
      });
      mockTaskFindFirst.mockResolvedValueOnce({
        initiatorUserId: null,
        initiatorAutomation: source,
      });
      mockPersistAutomationWorkItems.mockResolvedValueOnce({
        created: true,
        duplicateCount: 0,
        duplicateWorkItemRefs: [],
        workItems: [actWorkItem],
      });

      const app = createApp(authContext);
      const response = await app.request(
        new Request('http://localhost/tasks/task-1/automation_work_items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workItems: [
              {
                title: 'Fix parser nil access',
                brief: 'Nil access is driving a production issue.',
                actionKind: 'code_change_pr',
                disposition: 'act',
                executionPrompt:
                  '$implement-changes\nReproduce the issue, fix it, and open a PR.',
                targetRepositoryFullName: 'acme/app',
                targetEnvironmentId: environmentId,
              },
            ],
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(mockLaunchActWorkItems).toHaveBeenCalledWith(
        expect.objectContaining({
          executionTaskBootstrap: '$implement-changes',
          workItems: [actWorkItem],
        }),
      );
    },
  );

  it('rejects CI failure triage work item submissions after the one-task cutover', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    mockTaskRunFindFirst.mockResolvedValueOnce({
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        suggestionSource: 'ci_failure_triage',
        slackChannel: 'C123',
        slackThreadTs: '1781300000.000100',
      },
    });
    mockTaskFindFirst.mockResolvedValueOnce({
      initiatorUserId: null,
      initiatorAutomation: 'ci_failure_triage',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a failing CI run.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                '$implement-changes\nReproduce the failing job, fix it, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'CI failure triage no longer uses automation work items. Investigate and fix in the launched standard task.',
    });
    expect(mockLaunchActWorkItems).not.toHaveBeenCalled();
  });

  it('rejects CI failure triage work items from StandardTask using initiator stamp', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    mockTaskRunFindFirst.mockResolvedValueOnce({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: null,
      payload: {
        repo: 'acme/app',
        environmentId,
        selectedRepositories: ['acme/app'],
        description: '$ci-failure-triage',
      },
    });
    mockTaskFindFirst.mockResolvedValueOnce({
      initiatorUserId: null,
      initiatorAutomation: 'ci_failure_triage',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a failing CI run.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                '$implement-changes\nReproduce the failing job, fix it, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'CI failure triage no longer uses automation work items. Investigate and fix in the launched standard task.',
    });
    expect(mockLaunchActWorkItems).not.toHaveBeenCalled();
  });

  it('falls back to non-Slack execution instructions when no Slack target resolves', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    const actWorkItem = buildActWorkItem();
    mockResolveAutomationSlackTarget.mockResolvedValueOnce(null);
    mockPersistAutomationWorkItems.mockResolvedValueOnce({
      created: true,
      duplicateCount: 0,
      duplicateWorkItemRefs: [],
      workItems: [actWorkItem],
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a production Sentry issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockLaunchActWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        chatTarget: null,
        workItems: [actWorkItem],
      }),
    );
  });
});
