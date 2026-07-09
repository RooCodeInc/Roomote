import { Hono } from 'hono';

import {
  type AuthTokenContext,
  TaskPayloadKind,
  type JobTokenContext,
} from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { submitAutomationWorkItems } from '../submitAutomationWorkItems';

const { mockCloudJobFindFirst, mockTaskFindFirst } = vi.hoisted(() => ({
  mockCloudJobFindFirst: vi.fn(),
  mockTaskFindFirst: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  CloudJobQueueEnqueueError: class CloudJobQueueEnqueueError extends Error {},
  enqueueCloudTask: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(() => ({
    postMessage: vi.fn(),
  })),
}));

vi.mock('../automation-work-items/teams.js', () => ({
  resolveAutomationTeamsTarget: vi.fn(async () => null),
  postLateBoundWorkItemFailureToTeams: vi.fn(async () => undefined),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn(),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  inArray: vi.fn((...args) => ({ type: 'inArray', args })),
  isNull: vi.fn((...args) => ({ type: 'isNull', args })),
  lte: vi.fn((...args) => ({ type: 'lte', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: vi.fn(),
  automationWorkItems: {},
  taskRuns: {
    taskId: 'taskRuns.taskId',
  },
  tasks: {
    id: 'tasks.id',
  },
  environments: {},
  repositories: {},
  slackInstallationChannels: {},
  slackInstallations: {},
  getAutomationRuntime: vi.fn(async () => ({
    slackChannelId: null,
  })),
  upsertBackgroundAutomationSlackThread: vi.fn(),
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockCloudJobFindFirst(...args),
      },
      tasks: {
        findFirst: (...args: unknown[]) => mockTaskFindFirst(...args),
      },
    },
  },
}));

function createApp(authContext?: AuthTokenContext | JobTokenContext) {
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

describe('submitAutomationWorkItems', () => {
  const authContext: JobTokenContext = {
    userId: 'user-1',
    principal: 'user',
    cloudJobId: 1,
    tokenType: 'cj',
    version: 1,
  };

  beforeEach(() => {
    mockCloudJobFindFirst.mockReset();
    mockTaskFindFirst.mockReset();
    mockCloudJobFindFirst.mockResolvedValue({
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
  });

  it('rejects act work items without a target repository', async () => {
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
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Act automation work items must include targetRepositoryFullName.',
    });
    expect(mockCloudJobFindFirst).not.toHaveBeenCalled();
  });

  it('rejects act work items without an execution prompt', async () => {
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
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Act automation work items must include executionPrompt.',
    });
    expect(mockCloudJobFindFirst).not.toHaveBeenCalled();
  });

  it('rejects act work items without a target environment', async () => {
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
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Act automation work items must include targetEnvironmentId.',
    });
    expect(mockCloudJobFindFirst).not.toHaveBeenCalled();
  });

  it('rejects Dependabot suggestion work items', async () => {
    mockCloudJobFindFirst.mockResolvedValueOnce({
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

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Suggest a dependency update',
              brief: 'This should be rejected for Dependabot auto-action.',
              actionKind: 'code_change_pr',
              disposition: 'suggest',
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Dependabot triage acts directly and may not submit suggestion work items.',
    });
  });

  it('rejects multiple Dependabot action work items for the same target environment', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    mockCloudJobFindFirst.mockResolvedValueOnce({
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

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Update braces',
              brief: 'Update braces safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate braces safely.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
            {
              title: 'Update minimist',
              brief: 'Update minimist safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate minimist safely.',
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
        'Dependabot triage may submit at most one work item per targetEnvironmentId.',
    });
  });

  it('rejects more than three Dependabot action work items', async () => {
    mockCloudJobFindFirst.mockResolvedValueOnce({
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

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Update braces',
              brief: 'Update braces safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate braces safely.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: '11111111-1111-1111-1111-111111111111',
            },
            {
              title: 'Update minimist',
              brief: 'Update minimist safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate minimist safely.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: '22222222-2222-2222-2222-222222222222',
            },
            {
              title: 'Update ws',
              brief: 'Update ws safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate ws safely.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: '33333333-3333-3333-3333-333333333333',
            },
            {
              title: 'Update semver',
              brief: 'Update semver safely.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$update-dependencies\nUpdate semver safely.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: '44444444-4444-4444-4444-444444444444',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Dependabot triage may submit at most 3 act work items per run.',
    });
  });

  it('rejects Sentry suggestion work items', async () => {
    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Mute noisy Sentry issue',
              brief: 'This should run as an act execution task instead.',
              actionKind: 'sentry_issue_mutation',
              disposition: 'suggest',
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Sentry triage acts directly and may not submit suggestion work items.',
    });
  });

  it('rejects more than one Sentry action work item', async () => {
    const firstEnvironmentId = '11111111-1111-1111-1111-111111111111';
    const secondEnvironmentId = '22222222-2222-2222-2222-222222222222';
    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Fix the first production issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                '$implement-changes\nFix the first production issue.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: firstEnvironmentId,
            },
            {
              title: 'Fix setup insertBefore crash',
              brief: 'Fix the second production issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt:
                '$implement-changes\nFix the second production issue.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: secondEnvironmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Sentry triage may submit at most 1 act work item per run.',
    });
  });

  it('rejects Security Auditor suggestion work items', async () => {
    mockCloudJobFindFirst.mockResolvedValueOnce({
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        suggestionSource: 'security_auditor',
      },
    });
    mockTaskFindFirst.mockResolvedValueOnce({
      initiatorUserId: null,
      initiatorAutomation: 'security_auditor',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks/task-1/automation_work_items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workItems: [
            {
              title: 'Harden webhook signature validation',
              brief: 'This should run as an act execution task instead.',
              actionKind: 'code_change_pr',
              disposition: 'suggest',
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Security Auditor acts directly and may not submit suggestion work items.',
    });
  });

  it('rejects automation work items for unsupported task sources', async () => {
    const environmentId = '11111111-1111-1111-1111-111111111111';
    mockCloudJobFindFirst.mockResolvedValueOnce({
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        suggestionSource: 'suggest_ideas',
      },
    });
    mockTaskFindFirst.mockResolvedValueOnce({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
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
              brief: 'Fix the production issue.',
              actionKind: 'code_change_pr',
              disposition: 'act',
              executionPrompt: '$implement-changes\nFix the production issue.',
              targetRepositoryFullName: 'acme/app',
              targetEnvironmentId: environmentId,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Automation work items are not supported for this task source',
    });
  });
});
