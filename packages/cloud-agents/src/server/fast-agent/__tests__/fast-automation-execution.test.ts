const mocks = vi.hoisted(() => ({
  completeRun: vi.fn(),
  countUnsettledChildren: vi.fn(),
  countChildren: vi.fn(),
  listChildren: vi.fn(),
  suspendRun: vi.fn(),
  getRun: vi.fn(),
  getTaskModels: vi.fn(),
  getEnvironments: vi.fn(),
  generateText: vi.fn(),
  runSession: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  nativeExecutor: undefined as
    | ((call: {
        name: string;
        args: Record<string, unknown>;
      }) => Promise<unknown>)
    | undefined,
}));

const nativeToolNames = vi.hoisted(
  () =>
    ({
      cancelTask: 'cancel_task',
      completeAutomationRun: 'complete_automation_run',
      ignoreEvent: 'ignore_event',
      integrationCall: 'integration_call',
      launchTask: 'launch_task',
      manageTasks: 'manage_tasks',
      retryTaskStart: 'retry_task_start',
      sendChatReaction: 'send_chat_reaction',
      sendChatReply: 'send_chat_reply',
      sendTaskMessage: 'send_task_message',
    }) as const,
);

vi.mock('@roomote/db/server', () => ({
  completeAutomationRun: mocks.completeRun,
  countUnsettledAutomationRunChildren: mocks.countUnsettledChildren,
  countAutomationRunChildren: mocks.countChildren,
  listAutomationRunChildren: mocks.listChildren,
  suspendAutomationRunForChildren: mocks.suspendRun,
  renewAutomationRunLease: vi.fn(async () => true),
  recordAutomationRunUsage: vi.fn(),
  getActiveAutomationRunForPrincipal: mocks.getRun,
  getDeploymentTaskModelOptions: mocks.getTaskModels,
}));
vi.mock('../../router', () => ({
  getAvailableEnvironments: mocks.getEnvironments,
}));
vi.mock('../../non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: { fastAutomation: 'fast_automation' },
  generateTrackedNonTaskTextInOpenCodeSession: mocks.generateText,
}));
vi.mock('../fast-agent-opencode-session', () => ({
  fastAgentOpenCodeSessionManager: { run: mocks.runSession },
}));
vi.mock('../fast-agent-integration-broker', () => ({
  listFastAgentIntegrations: mocks.listIntegrations,
  callFastAgentIntegration: mocks.callIntegration,
}));
vi.mock('../fast-agent-native-tool-bridge', () => ({
  FAST_AGENT_NATIVE_TOOL_NAMES: nativeToolNames,
  FAST_AUTOMATION_NATIVE_TOOL_FILTER: {
    '*': false,
    cancel_task: true,
    complete_automation_run: true,
    ignore_event: true,
    integration_call: true,
    launch_task: true,
    manage_tasks: true,
    retry_task_start: true,
    send_chat_reaction: true,
    send_chat_reply: true,
    send_task_message: true,
  },
  getFastAgentNativeToolRuntime: vi.fn(async () => ({
    directory: '/tmp/fast-automation',
    env: {},
  })),
  bindFastAgentNativeToolExecutor: vi.fn((_sessionId, executor) => {
    mocks.nativeExecutor = executor;
    return vi.fn();
  }),
}));

import { runFastAutomationExecution } from '../fast-automation-execution';

const policy = {
  version: 1,
  reporting: 'silent_allowed' as const,
  childKickoff: 'silent_allowed' as const,
};

const adapter = {
  postReport: vi.fn(),
  launchTask: vi.fn(),
};

describe('Fast automation execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRun.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sourceKey: 'built_in:announcer',
      automationKey: 'announcer',
      promptSnapshot: 'Run the automation.',
      policySnapshot: policy,
    });
    mocks.getTaskModels.mockResolvedValue({ models: [] });
    mocks.getEnvironments.mockResolvedValue([]);
    mocks.listIntegrations.mockResolvedValue([]);
    mocks.completeRun.mockResolvedValue(true);
    mocks.countUnsettledChildren.mockResolvedValue(0);
    mocks.countChildren.mockResolvedValue(0);
    mocks.listChildren.mockResolvedValue([]);
    mocks.suspendRun.mockResolvedValue(true);
    mocks.runSession.mockImplementation(async ({ execute, prompt }) =>
      execute({}, prompt),
    );
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onSessionReady('opencode-session');
        await mocks.nativeExecutor?.({
          name: 'complete_automation_run',
          args: { outcome: 'skipped' },
        });
        return 'raw model text is not delivered';
      },
    );
  });

  it('records a silent no-op without posting raw model text', async () => {
    await expect(
      runFastAutomationExecution({
        automationRunId: '11111111-1111-4111-8111-111111111111',
        leaseOwner: 'worker-1',
        policyVersion: 1,
        adapter,
      }),
    ).resolves.toEqual({ status: 'skipped' });

    expect(adapter.postReport).not.toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('late-binds an optional report before terminal completion', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onSessionReady('opencode-session');
        await mocks.nativeExecutor?.({
          name: 'send_chat_reply',
          args: {
            purpose: 'closeout',
            logicalMessageKey: 'finding',
            message: 'One actionable finding.',
          },
        });
        await mocks.nativeExecutor?.({
          name: 'complete_automation_run',
          args: { outcome: 'succeeded', summary: 'Finding reported.' },
        });
        return '';
      },
    );

    await expect(
      runFastAutomationExecution({
        automationRunId: '11111111-1111-4111-8111-111111111111',
        leaseOwner: 'worker-1',
        policyVersion: 1,
        adapter,
      }),
    ).resolves.toEqual({
      status: 'succeeded',
      summary: 'Finding reported.',
    });
    expect(adapter.postReport).toHaveBeenCalledWith({
      automationRunId: '11111111-1111-4111-8111-111111111111',
      logicalMessageKey: 'finding',
      message: 'One actionable finding.',
    });
  });

  it('suspends the parent while a delegated child is unsettled', async () => {
    mocks.countUnsettledChildren.mockResolvedValue(1);
    mocks.countChildren.mockResolvedValue(1);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onSessionReady('opencode-session');
        await mocks.nativeExecutor?.({
          name: 'complete_automation_run',
          args: { outcome: 'succeeded' },
        });
        return '';
      },
    );

    await expect(
      runFastAutomationExecution({
        automationRunId: '11111111-1111-4111-8111-111111111111',
        leaseOwner: 'worker-1',
        policyVersion: 1,
        adapter,
      }),
    ).resolves.toEqual({ status: 'waiting_for_children' });
    expect(mocks.suspendRun).toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it('launches a child without an automation-specific environment scope', async () => {
    adapter.launchTask.mockResolvedValue({ success: true, taskId: 'task-1' });
    mocks.getEnvironments.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Available',
        repositoryNames: ['other/repo'],
      },
    ]);
    let launchResult: unknown;
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onSessionReady('opencode-session');
        launchResult = await mocks.nativeExecutor?.({
          name: 'launch_task',
          args: {
            prompt: 'Edit code.',
            environmentId: '33333333-3333-4333-8333-333333333333',
            idempotencyKey: 'fix-1',
          },
        });
        await mocks.nativeExecutor?.({
          name: 'complete_automation_run',
          args: { outcome: 'skipped' },
        });
        return '';
      },
    );

    await runFastAutomationExecution({
      automationRunId: '11111111-1111-4111-8111-111111111111',
      leaseOwner: 'worker-1',
      policyVersion: 1,
      adapter,
    });
    expect(launchResult).toEqual({ success: true, taskId: 'task-1' });
    expect(adapter.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: '33333333-3333-4333-8333-333333333333',
      }),
    );
  });

  it('terminalizes discovery failures before inference starts', async () => {
    mocks.listIntegrations.mockRejectedValue(
      new Error('integration discovery failed'),
    );

    await expect(
      runFastAutomationExecution({
        automationRunId: '11111111-1111-4111-8111-111111111111',
        leaseOwner: 'worker-1',
        policyVersion: 1,
        adapter,
      }),
    ).rejects.toThrow('integration discovery failed');
    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'integration discovery failed',
      }),
    );
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('allows a continuation turn to launch one child like a human Fast turn', async () => {
    adapter.launchTask.mockResolvedValue({ success: true, taskId: 'task-2' });
    mocks.getEnvironments.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Available',
        repositoryNames: ['other/repo'],
      },
    ]);
    let launchResult: unknown;
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onSessionReady('opencode-session');
        launchResult = await mocks.nativeExecutor?.({
          name: 'launch_task',
          args: {
            prompt: 'Edit code.',
            environmentId: '33333333-3333-4333-8333-333333333333',
            idempotencyKey: 'fix-1',
          },
        });
        await mocks.nativeExecutor?.({
          name: 'complete_automation_run',
          args: { outcome: 'skipped' },
        });
        return '';
      },
    );

    await runFastAutomationExecution({
      automationRunId: '11111111-1111-4111-8111-111111111111',
      leaseOwner: 'worker-1',
      policyVersion: 1,
      adapter,
      continuation: true,
    });

    expect(launchResult).toEqual({ success: true, taskId: 'task-2' });
    expect(adapter.launchTask).toHaveBeenCalled();
  });
});
