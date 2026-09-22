const mocks = vi.hoisted(() => ({
  findResult: vi.fn(),
  findTask: vi.fn(),
  findRun: vi.fn(),
  findAutomation: vi.fn(),
  findSession: vi.fn(),
  findPullRequests: vi.fn(),
  findArtifacts: vi.fn(),
  generate: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...values: unknown[]) => values),
  eq: vi.fn((...values: unknown[]) => values),
  isNull: vi.fn((value: unknown) => value),
  automationResults: {
    id: 'automation_results.id',
    preparationStatus: 'automation_results.preparation_status',
    acceptedAt: 'automation_results.accepted_at',
    ignoredAt: 'automation_results.ignored_at',
    supersededAt: 'automation_results.superseded_at',
  },
  customAutomations: { id: 'custom_automations.id' },
  taskArtifacts: {
    taskId: 'task_artifacts.task_id',
    sessionId: 'task_artifacts.session_id',
  },
  taskPullRequests: { taskId: 'task_pull_requests.task_id' },
  taskRuns: { id: 'task_runs.id' },
  tasks: { id: 'tasks.id' },
  sessions: { id: 'sessions.id' },
  db: {
    query: {
      automationResults: { findFirst: mocks.findResult, findMany: vi.fn() },
      tasks: { findFirst: mocks.findTask },
      taskRuns: { findFirst: mocks.findRun },
      customAutomations: { findFirst: mocks.findAutomation },
      sessions: { findFirst: mocks.findSession },
      taskPullRequests: { findMany: mocks.findPullRequests },
      taskArtifacts: { findMany: mocks.findArtifacts },
    },
    update: mocks.update,
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    automationResultPreparation: 'automation_result_preparation',
  },
  generateTrackedNonTaskObject: mocks.generate,
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn() }));

import { processAutomationResultPreparation } from './automation-result-preparation';

describe('automation result preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue([]);
    mocks.findResult.mockResolvedValue({
      id: 'result-1',
      preparationStatus: 'pending',
      preparationAttempts: 0,
      automationName: 'Security audit',
      content: 'Found one dependency risk.',
      sourceTaskId: 'task-1',
      sourceRunId: 42,
      sourceSessionId: 'session-1',
      customAutomationId: null,
      userId: 'user-1',
    });
    mocks.findTask.mockResolvedValue({
      id: 'task-1',
      title: 'Audit dependencies',
      prompt: 'Find dependency risks.',
      state: 'completed',
    });
    mocks.findRun.mockResolvedValue({
      status: 'completed',
      errorCode: null,
      error: null,
    });
    mocks.findSession.mockResolvedValue({
      fastConversationId: 'fast-conversation-1',
    });
    mocks.findPullRequests.mockResolvedValue([
      { id: 'pr-1', prTitle: 'Update dependency', status: 'open' },
    ]);
    mocks.findArtifacts.mockResolvedValue([]);
  });

  it('stores bounded copy and only validated reference keys', async () => {
    mocks.generate.mockResolvedValue({
      object: {
        headline: 'One dependency risk needs review',
        decisionContext: 'The finding is limited to the audited workspace.',
        referenceKeys: ['task:task-1', 'pr:pr-1', 'https://invented.test'],
      },
    });

    await processAutomationResultPreparation({
      resultId: 'result-1',
      finalAttempt: false,
    });

    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'automation_result_preparation',
        modelRole: 'small',
      }),
    );
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        headline: 'One dependency risk needs review',
        selectedReferenceKeys: ['task:task-1', 'pr:pr-1'],
        preparationStatus: 'ready',
      }),
    );
  });

  it('keeps persisted fallback copy and marks the terminal failure', async () => {
    mocks.generate.mockRejectedValue(new Error('provider unavailable'));

    await processAutomationResultPreparation({
      resultId: 'result-1',
      finalAttempt: true,
    });

    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        preparationStatus: 'failed',
        preparationErrorCode: 'generation_failed',
      }),
    );
  });
});
