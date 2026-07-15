import { Hono } from 'hono';

import { type RunTokenContext, TaskPayloadKind } from '@roomote/types';

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
  mockPostMessage,
  insertedWorkItemValues,
  insertedTrackedMessageValues,
} = vi.hoisted(() => ({
  mockTaskRunFindFirst: vi.fn(),
  mockTaskFindFirst: vi.fn(),
  mockDeploymentSettingsFindFirst: vi.fn(),
  mockPostMessage: vi.fn(),
  insertedWorkItemValues: [] as Record<string, unknown>[],
  insertedTrackedMessageValues: [] as Record<string, unknown>[],
}));

// Mutable so a test can simulate "Slack installed but no channel resolves".
let slackInstallationChannelRows: unknown[] = [{ channelId: 'C-FALLBACK' }];

function makeSelectResult(name: string): unknown[] {
  switch (name) {
    case 'repositories':
      return [{ id: 'repo-1', fullName: 'acme/app' }];
    case 'slackInstallations':
      return [{ id: 'inst-1', botAccessToken: 'xoxb-test', teamId: 'T1' }];
    case 'slackInstallationChannels':
      return slackInstallationChannelRows;
    // Existing suggestion work_items + existing summary tracked_messages both
    // resolve empty so the persist + post paths run fresh.
    case 'workItems':
    case 'trackedMessages':
    case 'environments':
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
        insertedWorkItemValues.push(...values);
      }
      if (tableName === 'trackedMessages') {
        insertedTrackedMessageValues.push(...values);
      }
      return {
        returning() {
          if (tableName === 'workItems') {
            return Promise.resolve(
              values.map((value, index) => ({ ...value, id: `wi-${index}` })),
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
    },
    select: () => createSelectBuilder(),
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
            targetRepositoryFullName: 'acme/app',
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
    mockPostMessage.mockReset();
    insertedWorkItemValues.length = 0;
    insertedTrackedMessageValues.length = 0;
    slackInstallationChannelRows = [{ channelId: 'C-FALLBACK' }];
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
    });

    // Regression 1: a null poster does not suppress the Slack summary post
    // (root message + one suggestion card).
    expect(mockPostMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(insertedTrackedMessageValues).toHaveLength(1);
    expect(insertedTrackedMessageValues[0]).toMatchObject({
      createdByUserId: null,
    });
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
