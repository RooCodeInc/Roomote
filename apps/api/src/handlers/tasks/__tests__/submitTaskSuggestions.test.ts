import { Hono } from 'hono';

import {
  ALL_REPOSITORIES,
  type RunTokenContext,
  TaskPayloadKind,
} from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { submitTaskSuggestions } from '../submitTaskSuggestions';
import { getAutomationRuntime } from '@roomote/db/server';
import { postScheduledSuggestionsToTelegram } from '../../telegram/automation-suggestions';
import { postScheduledSuggestionsToTeams } from '../../teams/automation-suggestions';
import { postScheduledSuggestionsToDiscord } from '../../discord/automation-suggestions';

const {
  mockTaskRunFindFirst,
  mockTaskFindFirst,
  mockDeploymentSettingsFindFirst,
  mockSlackInstallationFindFirst,
  mockEnvironmentFindFirst,
  mockFindEnvironmentForRepo,
  mockPostMessage,
  insertedWorkItemValues,
  insertedTrackedMessageValues,
} = vi.hoisted(() => ({
  mockTaskRunFindFirst: vi.fn(),
  mockTaskFindFirst: vi.fn(),
  mockDeploymentSettingsFindFirst: vi.fn(),
  mockSlackInstallationFindFirst: vi.fn(),
  mockEnvironmentFindFirst: vi.fn(),
  mockFindEnvironmentForRepo: vi.fn(),
  mockPostMessage: vi.fn(),
  insertedWorkItemValues: [] as Record<string, unknown>[],
  insertedTrackedMessageValues: [] as Record<string, unknown>[],
}));

// Mutable so a test can simulate "Slack installed but no channel resolves".
let slackInstallationChannelRows: unknown[] = [{ channelId: 'C-FALLBACK' }];
let repositoryRows = [{ id: 'repo-1', fullName: 'acme/app' }];

function makeSelectResult(name: string): unknown[] {
  switch (name) {
    case 'repositories':
      return repositoryRows;
    case 'slackInstallations':
      return [{ id: 'inst-1', botAccessToken: 'xoxb-test', teamId: 'T1' }];
    case 'slackInstallationChannels':
      return slackInstallationChannelRows;
    // Existing suggestion work_items + existing summary tracked_messages both
    // resolve empty so the persist + post paths run fresh.
    case 'workItems':
      return insertedWorkItemValues;
    case 'trackedMessages':
      return [];
    case 'environments':
      return [
        {
          id: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
          config: { repositories: [{ repository: 'acme/app' }] },
        },
      ];
    default:
      return [];
  }
}

function createSelectBuilder() {
  let tableName = '';
  const builder = {
    from(table: { _name?: string }) {
      tableName = table?._name ?? '';
      return builder;
    },
    where() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      return builder;
    },
    then<T>(
      resolve: (rows: unknown[]) => T,
      reject?: (error: unknown) => T,
    ): Promise<T> {
      return Promise.resolve(makeSelectResult(tableName)).then(resolve, reject);
    },
  };
  return builder;
}

function createInsertBuilder(table: { _name?: string }) {
  const tableName = table?._name ?? '';
  return {
    values(values: Record<string, unknown>[]) {
      if (tableName === 'workItems') {
        const rows = values.map((value, index) => ({
          ...value,
          id: `wi-${insertedWorkItemValues.length + index}`,
        }));
        insertedWorkItemValues.push(...rows);
      }
      if (tableName === 'trackedMessages') {
        insertedTrackedMessageValues.push(...values);
      }
      return {
        returning() {
          if (tableName === 'workItems') {
            return Promise.resolve(
              insertedWorkItemValues.slice(-values.length),
            );
          }
          return Promise.resolve([]);
        },
        onConflictDoNothing() {
          return Promise.resolve(undefined);
        },
      };
    },
  };
}

function createUpdateBuilder() {
  const builder = {
    set() {
      return builder;
    },
    where() {
      return Promise.resolve(undefined);
    },
  };
  return builder;
}

const tx = {
  execute: vi.fn(async () => undefined),
  select: () => createSelectBuilder(),
  insert: (table: { _name?: string }) => createInsertBuilder(table),
  update: () => createUpdateBuilder(),
};

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    postMessage = mockPostMessage;
  },
}));

vi.mock('@roomote/communication/chat-messages', () => ({
  SETUP_SUGGESTIONS_THREAD_INTRO_TEXT: 'intro',
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  findEnvironmentForRepo: mockFindEnvironmentForRepo,
}));

vi.mock('@roomote/sdk/server', () => ({
  buildAutomationRootSummaryMessage: vi.fn(({ summaryText }) => ({
    text: summaryText,
  })),
  buildAutomationRootSummaryText: vi.fn(({ summaryText }) => summaryText),
  enqueueSlackSuggestedTasksOnboardingFollowup: vi.fn(),
  shouldPostHistoricalThreadFeedbackDebugSnippet: vi.fn(async () => false),
}));

vi.mock('../background-automation-slack', () => ({
  resolveScheduledSuggestionSlackConfig: vi.fn(() => ({
    suggestionType: 'suggested_tasks',
    automationKey: 'suggest_ideas',
    automationSettingsHash: undefined,
    actionFooterText: 'footer',
  })),
}));

vi.mock('../scheduled-suggestion-root-summary', () => ({
  buildScheduledSuggestionRootMessage: vi.fn(async () => ({
    summaryText: 'summary',
    actionFooterText: 'footer',
  })),
}));

vi.mock('../../telegram/automation-suggestions', () => ({
  postScheduledSuggestionsToTelegram: vi.fn(),
}));

vi.mock('../../teams/automation-suggestions', () => ({
  postScheduledSuggestionsToTeams: vi.fn(),
}));

vi.mock('../../discord/automation-suggestions', () => ({
  postScheduledSuggestionsToDiscord: vi.fn(),
}));

vi.mock('../../discord/setup-suggestions', () => ({
  postSetupTaskSuggestionsToDiscord: vi.fn(),
}));

vi.mock('../../telegram/setup-suggestions', () => ({
  postSetupTaskSuggestionsToTelegram: vi.fn(),
}));

vi.mock('../../teams/setup-suggestions', () => ({
  postSetupTaskSuggestionsToTeams: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn((...args) => ({ type: 'asc', args })),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  inArray: vi.fn((...args) => ({ type: 'inArray', args })),
  sql: Object.assign((...args: unknown[]) => ({ type: 'sql', args }), {
    raw: (value: unknown) => value,
  }),
  buildTaskSuggestionContentHash: vi.fn(() => 'fingerprint'),
  resolveRepositorySelectionByIds: vi.fn(),
  upsertBackgroundAutomationSlackThread: vi.fn(),
  getAutomationRuntime: vi.fn(async () => ({ slackChannelId: 'C-AUTO' })),
  environments: { _name: 'environments' },
  repositories: { _name: 'repositories' },
  slackInstallationChannels: { _name: 'slackInstallationChannels' },
  slackInstallations: { _name: 'slackInstallations' },
  slackUserMappings: { _name: 'slackUserMappings' },
  taskRuns: { _name: 'taskRuns' },
  tasks: { _name: 'tasks' },
  trackedMessages: { _name: 'trackedMessages' },
  workItems: { _name: 'workItems' },
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunFindFirst(...args),
      },
      tasks: { findFirst: (...args: unknown[]) => mockTaskFindFirst(...args) },
      deploymentSettings: {
        findFirst: (...args: unknown[]) =>
          mockDeploymentSettingsFindFirst(...args),
      },
      slackInstallations: {
        findFirst: (...args: unknown[]) =>
          mockSlackInstallationFindFirst(...args),
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentFindFirst(...args),
      },
    },
    select: () => createSelectBuilder(),
    insert: (table: { _name?: string }) => createInsertBuilder(table),
    transaction: async (cb: (executor: typeof tx) => unknown) => cb(tx),
  },
}));

function createApp(authContext: RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/tasks/:taskId/task_suggestions', submitTaskSuggestions);

  return app;
}

function requestSuggestions(app: Hono<{ Variables: Variables }>) {
  return app.request(
    new Request('http://localhost/tasks/task-1/task_suggestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        suggestions: [
          {
            title: 'Fix the parser',
            brief: 'Nil access is crashing the parser.',
            category: 'bug',
            priority: 'P1',
            investigationContext: 'Parser crash path in apps/api.',
            targetRepositoryFullName: 'acme/app',
            workspaceReadiness: 'bare_repo',
          },
        ],
      }),
    }),
  );
}

function requestCurrentThreadSuggestions(
  app: Hono<{ Variables: Variables }>,
  submissionKey = 'reply-1',
) {
  return app.request(
    new Request('http://localhost/tasks/task-1/task_suggestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        delivery: 'current_thread',
        submissionKey,
        suggestions: [
          {
            title: 'Fix the parser',
            brief: 'Nil access is crashing the parser.',
            category: 'bug',
            priority: 'P0',
            investigationContext: 'Legacy hidden context.',
            targetRepositoryFullName: 'wrong/repository',
            targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
            workspaceReadiness: 'environment_backed',
            readinessMessage: 'Legacy readiness message.',
          },
        ],
      }),
    }),
  );
}

describe('submitTaskSuggestions', () => {
  beforeEach(() => {
    mockTaskRunFindFirst.mockReset();
    mockTaskFindFirst.mockReset();
    mockDeploymentSettingsFindFirst.mockReset();
    mockSlackInstallationFindFirst.mockReset();
    mockEnvironmentFindFirst.mockReset();
    mockFindEnvironmentForRepo.mockReset();
    mockPostMessage.mockReset();
    insertedWorkItemValues.length = 0;
    insertedTrackedMessageValues.length = 0;
    slackInstallationChannelRows = [{ channelId: 'C-FALLBACK' }];
    repositoryRows = [{ id: 'repo-1', fullName: 'acme/app' }];
    vi.mocked(getAutomationRuntime).mockResolvedValue({
      slackChannelId: 'C-AUTO',
    } as unknown as Awaited<ReturnType<typeof getAutomationRuntime>>);
    vi.mocked(postScheduledSuggestionsToTelegram).mockReset();
    vi.mocked(postScheduledSuggestionsToTeams).mockReset();
    vi.mocked(postScheduledSuggestionsToDiscord).mockReset();
    vi.mocked(postScheduledSuggestionsToDiscord).mockResolvedValue(false);

    let ts = 0;
    mockPostMessage.mockImplementation(async () => `ts-${++ts}`);
    mockDeploymentSettingsFindFirst.mockResolvedValue({ setupNewState: {} });
    mockSlackInstallationFindFirst.mockResolvedValue({
      botAccessToken: 'xoxb-test',
    });
    mockEnvironmentFindFirst.mockResolvedValue(null);
    mockFindEnvironmentForRepo.mockResolvedValue(undefined);
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: null,
      payload: {
        repo: 'acme/app',
        selectedRepositories: ['acme/app'],
        notifySlack: true,
      },
    });
  });

  it('posts standard task suggestions inside the task thread without a second root message', async () => {
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: 'user-1',
      payload: {
        repo: 'acme/app',
      },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await requestCurrentThreadSuggestions(app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      suggestionCount: 1,
    });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
      }),
    );
    expect(insertedTrackedMessageValues).toHaveLength(1);
    expect(insertedTrackedMessageValues[0]).toMatchObject({
      channelId: 'C123',
      metadata: {
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      },
    });
    expect(insertedWorkItemValues[0]).toMatchObject({
      title: 'Fix the parser',
      brief: 'Nil access is crashing the parser.',
      category: null,
      priority: null,
      investigationContext: null,
      targetRepositoryFullName: null,
      targetEnvironmentId: null,
      workspaceReadiness: null,
      readinessMessage: null,
    });
  });

  it('allows Slack app mention replies to attach suggestions', async () => {
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.SlackAppMention,
      actingUserId: 'user-1',
      payload: { repo: 'acme/app' },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await requestCurrentThreadSuggestions(app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      suggestionCount: 1,
    });
  });

  it('keeps current-thread scan suggestions pinned to verified metadata', async () => {
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.Scan,
      actingUserId: 'user-1',
      payload: { repo: 'acme/app', selectedRepositories: ['acme/app'] },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: 'suggest_ideas',
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/tasks/task-1/task_suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delivery: 'current_thread',
          submissionKey: 'scan-reply',
          suggestions: [
            {
              title: 'Fix the parser',
              brief: 'Nil access is crashing the parser.',
              category: 'bug',
              priority: 'P1',
              investigationContext: 'Parser crash path in apps/api.',
              targetRepositoryFullName: 'acme/app',
              workspaceReadiness: 'bare_repo',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(insertedWorkItemValues[0]).toMatchObject({
      category: 'bug',
      priority: 'P1',
      investigationContext: 'Parser crash path in apps/api.',
      targetRepositoryFullName: 'acme/app',
      workspaceReadiness: 'bare_repo',
    });
    expect(insertedTrackedMessageValues[0]?.metadata).not.toHaveProperty(
      'launchRouting',
    );
  });

  it('resolves standard task repositories from the selected environment', async () => {
    mockEnvironmentFindFirst.mockResolvedValue({
      config: { repositories: [{ repository: 'acme/app' }] },
    });
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: 'user-1',
      payload: {
        repo: '',
        environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await requestCurrentThreadSuggestions(app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      suggestionCount: 1,
    });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('pins org-wide current-thread suggestions to a concrete repository', async () => {
    repositoryRows = [
      { id: 'repo-1', fullName: 'acme/app' },
      { id: 'repo-2', fullName: 'acme/api' },
    ];
    mockFindEnvironmentForRepo.mockResolvedValue(
      '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
    );
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: 'user-1',
      payload: { repo: ALL_REPOSITORIES },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: 'custom_automation',
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/tasks/task-1/task_suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delivery: 'current_thread',
          submissionKey: 'org-wide-reply',
          suggestions: [
            {
              title: 'Fix the parser',
              brief: 'Nil access is crashing the parser.',
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(insertedWorkItemValues[0]).toMatchObject({
      targetRepositoryFullName: 'acme/app',
      targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      repositoryIds: ['repo-1'],
    });
    expect(insertedTrackedMessageValues[0]?.metadata).not.toHaveProperty(
      'launchRouting',
    );
  });

  it.each([
    {
      description: 'standard suggestions without a target repository',
      payloadKind: TaskPayloadKind.StandardTask,
      targetRepositoryFullName: undefined,
      expectedError:
        'targetRepositoryFullName is required for org-wide current-thread suggestions',
    },
    {
      description: 'scan suggestions without a target repository',
      payloadKind: TaskPayloadKind.Scan,
      targetRepositoryFullName: undefined,
      expectedError:
        'targetRepositoryFullName is required for org-wide current-thread suggestions',
    },
    {
      description: 'standard suggestions with an unknown target repository',
      payloadKind: TaskPayloadKind.StandardTask,
      targetRepositoryFullName: 'wrong/repository',
      expectedError:
        'targetRepositoryFullName "wrong/repository" is not part of this org-wide task',
    },
    {
      description: 'scan suggestions with an unknown target repository',
      payloadKind: TaskPayloadKind.Scan,
      targetRepositoryFullName: 'wrong/repository',
      expectedError:
        'targetRepositoryFullName "wrong/repository" is not part of this org-wide task',
    },
  ])(
    'rejects org-wide current-thread $description',
    async ({ payloadKind, targetRepositoryFullName, expectedError }) => {
      mockTaskRunFindFirst.mockResolvedValue({
        id: 1,
        payloadKind,
        actingUserId: 'user-1',
        payload: { repo: ALL_REPOSITORIES },
      });
      mockTaskFindFirst.mockResolvedValue({
        initiatorUserId: 'user-1',
        initiatorAutomation: 'custom_automation',
        slackChannelId: 'C123',
        slackThreadTs: '111.222',
      });
      const app = createApp({
        runId: 1,
        userId: 'user-1',
        principal: 'user',
        tokenType: 'run',
        version: 1,
      });

      const response = await app.request(
        new Request('http://localhost/tasks/task-1/task_suggestions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            delivery: 'current_thread',
            submissionKey: 'org-wide-reply',
            suggestions: [
              {
                title: 'Fix the parser',
                brief: 'Nil access is crashing the parser.',
                ...(targetRepositoryFullName
                  ? { targetRepositoryFullName }
                  : {}),
              },
            ],
          }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: expectedError,
      });
      expect(insertedWorkItemValues).toHaveLength(0);
    },
  );

  it('persists later reply suggestion batches independently', async () => {
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: 'user-1',
      payload: { repo: 'acme/app' },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    expect((await requestCurrentThreadSuggestions(app, 'reply-1')).status).toBe(
      200,
    );
    expect((await requestCurrentThreadSuggestions(app, 'reply-2')).status).toBe(
      200,
    );

    expect(insertedWorkItemValues).toHaveLength(2);
    expect(insertedWorkItemValues.map((item) => item.sortOrder)).toEqual([
      0, 1,
    ]);
    expect(insertedWorkItemValues[0]?.fingerprint).toMatch(/^reply-1:/);
    expect(insertedWorkItemValues[1]?.fingerprint).toMatch(/^reply-2:/);
  });

  it('reports partial Slack card delivery as incomplete', async () => {
    mockTaskRunFindFirst.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: 'user-1',
      payload: { repo: 'acme/app' },
    });
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
    });
    mockPostMessage
      .mockResolvedValueOnce('card-1')
      .mockResolvedValueOnce(undefined);
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const response = await app.request(
      new Request('http://localhost/tasks/task-1/task_suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delivery: 'current_thread',
          submissionKey: 'reply-partial',
          suggestions: [
            {
              title: 'First',
              brief: 'First action.',
              targetRepositoryFullName: 'acme/app',
            },
            {
              title: 'Second',
              brief: 'Second action.',
              targetRepositoryFullName: 'acme/app',
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    expect(insertedTrackedMessageValues).toHaveLength(1);
  });

  it('posts to Slack and stamps automationKey for an automation-initiated scan with no user', async () => {
    // Automation service principal: null user everywhere.
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: null,
      initiatorAutomation: 'suggest_ideas',
    });

    const authContext: RunTokenContext = {
      runId: 1,
      userId: null,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };
    const app = createApp(authContext);

    const response = await requestSuggestions(app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      suggestionCount: 1,
    });

    // Regression 2: work_items stamped with the initiating automation.
    expect(insertedWorkItemValues).toHaveLength(1);
    expect(insertedWorkItemValues[0]).toMatchObject({
      kind: 'suggestion',
      automationKey: 'suggest_ideas',
      category: 'bug',
      priority: 'P1',
      investigationContext: 'Parser crash path in apps/api.',
      targetRepositoryFullName: 'acme/app',
      workspaceReadiness: 'bare_repo',
    });

    // Regression 1: a null poster does not suppress the Slack summary post
    // (root message + one suggestion card).
    expect(mockPostMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(insertedTrackedMessageValues).toHaveLength(1);
    expect(insertedTrackedMessageValues[0]).toMatchObject({
      createdByUserId: null,
    });
  });

  it('keeps mixed-readiness suggestion batches above the old limit of five', async () => {
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: 'suggest_ideas',
    });
    const app = createApp({
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });

    const suggestions = Array.from({ length: 6 }, (_, index) => ({
      title: `Suggestion ${index + 1}`,
      brief: `Action ${index + 1}.`,
      targetRepositoryFullName: 'acme/app',
      ...(index % 2 === 0
        ? {
            targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
            workspaceReadiness: 'environment_backed',
          }
        : { workspaceReadiness: 'bare_repo' }),
    }));

    const response = await app.request(
      new Request('http://localhost/tasks/task-1/task_suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suggestions }),
      }),
    );

    expect(response.status).toBe(200);
    expect(insertedWorkItemValues).toHaveLength(6);
  });

  it('still posts and leaves automationKey null for a user-initiated scan', async () => {
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: 'user-1',
      initiatorAutomation: null,
    });

    const authContext: RunTokenContext = {
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };
    const app = createApp(authContext);

    const response = await requestSuggestions(app);

    expect(response.status).toBe(200);
    expect(insertedWorkItemValues).toHaveLength(1);
    expect(insertedWorkItemValues[0]).toMatchObject({
      kind: 'suggestion',
      automationKey: null,
    });
    expect(mockPostMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(insertedTrackedMessageValues[0]).toMatchObject({
      createdByUserId: 'user-1',
    });
  });

  it('falls through Discord to Telegram when Slack has no destination', async () => {
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: null,
      initiatorAutomation: 'suggest_ideas',
    });

    // Slack installation exists, but neither the automation runtime nor the
    // installation channels resolve a destination -> Slack does not deliver.
    vi.mocked(getAutomationRuntime).mockResolvedValue({
      slackChannelId: undefined,
    } as unknown as Awaited<ReturnType<typeof getAutomationRuntime>>);
    slackInstallationChannelRows = [];
    // Telegram delivers, so Teams must NOT fire.
    vi.mocked(postScheduledSuggestionsToTelegram).mockResolvedValue(true);

    const authContext: RunTokenContext = {
      runId: 1,
      userId: null,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };
    const app = createApp(authContext);

    const response = await requestSuggestions(app);

    expect(response.status).toBe(200);
    // Slack never posted a root message (no channel).
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(postScheduledSuggestionsToDiscord).toHaveBeenCalledTimes(1);
    // Telegram fallback fired despite the active Slack installation.
    expect(postScheduledSuggestionsToTelegram).toHaveBeenCalledTimes(1);
    // Telegram delivered, so Teams is suppressed.
    expect(postScheduledSuggestionsToTeams).not.toHaveBeenCalled();
  });

  it('stops fallback delivery when Discord accepts the suggestions', async () => {
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: null,
      initiatorAutomation: 'suggest_ideas',
    });
    vi.mocked(getAutomationRuntime).mockResolvedValue({
      slackChannelId: undefined,
    } as unknown as Awaited<ReturnType<typeof getAutomationRuntime>>);
    slackInstallationChannelRows = [];
    vi.mocked(postScheduledSuggestionsToDiscord).mockResolvedValue(true);

    const app = createApp({
      runId: 1,
      userId: null,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
    const response = await requestSuggestions(app);

    expect(response.status).toBe(200);
    expect(postScheduledSuggestionsToDiscord).toHaveBeenCalledTimes(1);
    expect(postScheduledSuggestionsToTelegram).not.toHaveBeenCalled();
    expect(postScheduledSuggestionsToTeams).not.toHaveBeenCalled();
  });

  it('skips Slack when the automation targets a Discord channel', async () => {
    mockTaskFindFirst.mockResolvedValue({
      initiatorUserId: null,
      initiatorAutomation: 'suggest_ideas',
    });
    // Slack could deliver (its channel resolves), but the automation's own
    // destination target is a Discord channel, so the summary belongs there.
    vi.mocked(getAutomationRuntime).mockResolvedValue({
      slackChannelId: 'C-AUTO',
      destination: {
        provider: 'discord',
        channelId: 'discord-channel-1',
        source: 'automation_target',
      },
    } as unknown as Awaited<ReturnType<typeof getAutomationRuntime>>);
    vi.mocked(postScheduledSuggestionsToDiscord).mockResolvedValue(true);

    const app = createApp({
      runId: 1,
      userId: null,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
    const response = await requestSuggestions(app);

    expect(response.status).toBe(200);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(postScheduledSuggestionsToDiscord).toHaveBeenCalledTimes(1);
    expect(postScheduledSuggestionsToTelegram).not.toHaveBeenCalled();
  });
});
