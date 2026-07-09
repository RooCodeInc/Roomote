import { persistAutomationWorkItems } from '../persistence.js';

const {
  mockDbTransaction,
  mockSelect,
  mockExecute,
  mockInsert,
  mockBuildAutomationWorkItemsSummaryLockKey,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockSelect: vi.fn(),
  mockExecute: vi.fn(),
  mockInsert: vi.fn(),
  mockBuildAutomationWorkItemsSummaryLockKey: vi.fn(() => 'lock-key'),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn((...args) => ({ type: 'asc', args })),
  automationWorkItems: {
    id: 'automationWorkItems.id',
    sourceTaskId: 'automationWorkItems.sourceTaskId',
    automationKey: 'automationWorkItems.automationKey',
    title: 'automationWorkItems.title',
    brief: 'automationWorkItems.brief',
    category: 'automationWorkItems.category',
    priority: 'automationWorkItems.priority',
    actionKind: 'automationWorkItems.actionKind',
    disposition: 'automationWorkItems.disposition',
    status: 'automationWorkItems.status',
    investigationContext: 'automationWorkItems.investigationContext',
    executionPrompt: 'automationWorkItems.executionPrompt',
    fingerprint: 'automationWorkItems.fingerprint',
    repositoryIds: 'automationWorkItems.repositoryIds',
    targetRepositoryFullName: 'automationWorkItems.targetRepositoryFullName',
    targetEnvironmentId: 'automationWorkItems.targetEnvironmentId',
    workspaceReadiness: 'automationWorkItems.workspaceReadiness',
    readinessMessage: 'automationWorkItems.readinessMessage',
    sortOrder: 'automationWorkItems.sortOrder',
    executionTaskId: 'automationWorkItems.executionTaskId',
    launchError: 'automationWorkItems.launchError',
    updatedAt: 'automationWorkItems.updatedAt',
    createdAt: 'automationWorkItems.createdAt',
  },
  buildTaskSuggestionContentHash: vi.fn(),
  db: {
    transaction: (...args: unknown[]) => mockDbTransaction(...args),
  },
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  inArray: vi.fn((...args) => ({ type: 'inArray', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
  taskSuggestions: {
    id: 'taskSuggestions.id',
    automationWorkItemId: 'taskSuggestions.automationWorkItemId',
  },
}));

vi.mock('../source.js', () => ({
  buildAutomationWorkItemsSummaryLockKey:
    mockBuildAutomationWorkItemsSummaryLockKey,
}));

vi.mock('../row-projection.js', () => ({
  persistedAutomationWorkItemProjection: { id: 'persistedWorkItem.id' },
}));

function createSelectChain(params: {
  rows: unknown;
  includeOrderBy?: boolean;
}) {
  const where = vi.fn(() => {
    if (params.includeOrderBy) {
      return {
        orderBy: vi.fn(async () => params.rows),
      };
    }

    return Promise.resolve(params.rows);
  });

  return {
    from: vi.fn(() => ({ where })),
  };
}

describe('persistAutomationWorkItems', () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockExecute.mockReset();
    mockInsert.mockReset();
    mockBuildAutomationWorkItemsSummaryLockKey.mockClear();

    mockDbTransaction.mockImplementation(async (callback) =>
      callback({
        execute: mockExecute,
        insert: mockInsert,
        select: mockSelect,
      }),
    );
  });

  it('returns duplicate work item refs from the persistence snapshot when every prepared work item dedupes against an active batch', async () => {
    mockSelect
      .mockReturnValueOnce(
        createSelectChain({
          rows: [],
          includeOrderBy: true,
        }),
      )
      .mockReturnValueOnce(
        createSelectChain({
          rows: [{ id: 'existing-work-item-1', fingerprint: 'fingerprint-1' }],
        }),
      );

    const result = await persistAutomationWorkItems({
      sourceTaskId: 'task-source-2',
      automationKey: 'sentry_triage',
      preparedWorkItems: [
        {
          title: 'Fix parser nil access',
          brief: 'Nil access is driving a production Sentry issue.',
          category: 'bug',
          priority: 'P1',
          actionKind: 'code_change_pr',
          disposition: 'act',
          investigationContext: '$sentry-triage\nIssue: SENTRY-123',
          executionPrompt:
            'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
          fingerprint: 'fingerprint-1',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: null,
          workspaceReadiness: 'bare_repo',
          readinessMessage: 'Bare repo launch.',
        },
      ],
      repositoryIds: ['repo-1'],
    });

    expect(result).toEqual({
      created: true,
      duplicateCount: 1,
      duplicateWorkItemRefs: [
        { id: 'existing-work-item-1', fingerprint: 'fingerprint-1' },
      ],
      workItems: [],
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns duplicate work item refs in prepared fingerprint order', async () => {
    mockSelect
      .mockReturnValueOnce(
        createSelectChain({
          rows: [],
          includeOrderBy: true,
        }),
      )
      .mockReturnValueOnce(
        createSelectChain({
          rows: [
            { id: 'existing-work-item-1', fingerprint: 'fingerprint-1' },
            { id: 'existing-work-item-2', fingerprint: 'fingerprint-2' },
          ],
        }),
      );

    const result = await persistAutomationWorkItems({
      sourceTaskId: 'task-source-2',
      automationKey: 'sentry_triage',
      preparedWorkItems: [
        {
          title: 'Retry task link for fingerprint 2',
          brief: 'Prepared order should drive duplicate recovery order.',
          category: 'bug',
          priority: 'P1',
          actionKind: 'code_change_pr',
          disposition: 'act',
          investigationContext: '$sentry-triage\nIssue: SENTRY-456',
          executionPrompt: 'Recover the existing work item for fingerprint 2.',
          fingerprint: 'fingerprint-2',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: null,
          workspaceReadiness: 'bare_repo',
          readinessMessage: 'Bare repo launch.',
        },
        {
          title: 'Retry task link for fingerprint 1',
          brief: 'Prepared order should drive duplicate recovery order.',
          category: 'bug',
          priority: 'P1',
          actionKind: 'code_change_pr',
          disposition: 'act',
          investigationContext: '$sentry-triage\nIssue: SENTRY-123',
          executionPrompt: 'Recover the existing work item for fingerprint 1.',
          fingerprint: 'fingerprint-1',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: null,
          workspaceReadiness: 'bare_repo',
          readinessMessage: 'Bare repo launch.',
        },
      ],
      repositoryIds: ['repo-1'],
    });

    expect(result.duplicateWorkItemRefs).toEqual([
      { id: 'existing-work-item-2', fingerprint: 'fingerprint-2' },
      { id: 'existing-work-item-1', fingerprint: 'fingerprint-1' },
    ]);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
