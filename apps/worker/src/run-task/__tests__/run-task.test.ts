import { EventEmitter } from 'node:events';

const {
  activateSkillsFolderMock,
  awaitSubprocessMock,
  buildSandboxInstructionMock,
  cloudJobsDoneMock,
  cloudJobsRecordEventMock,
  cloudJobsStampMilestoneMock,
  cloudJobsSyncActingUserIdMock,
  cloudJobsSetHarnessSessionIdMock,
  cloudJobsUpdateRuntimeStateMock,
  cloudJobsUpdateMock,
  createHarnessMock,
  createInitialTaskStateMock,
  createServerMock,
  drainSlackMessagesMock,
  existsSyncMock,
  getDecryptedKeyMock,
  getMcpServerConfigsMock,
  harnessManagerInstances,
  hasActiveInstallationMock,
  isOrgEnabledMock,
  mockEvaluateFeatureFlag,
  resolvePackagedSkillsFolderMock,
  resolveStatusMock,
  syncRuntimeGitAuthorMock,
  startPollingMock,
  stopPollingMock,
  waitForShutdownMock,
  waitForExternalSleepActionMock,
  mkdirSyncMock,
  recordSandboxPromptSlackTurnStartMock,
  writeFileSyncMock,
  installZeroCliMock,
} = vi.hoisted(() => ({
  activateSkillsFolderMock: vi.fn(() => false),
  awaitSubprocessMock: vi.fn().mockResolvedValue(undefined),
  buildSandboxInstructionMock: vi.fn(() => undefined),
  cloudJobsDoneMock: vi.fn().mockResolvedValue(undefined),
  cloudJobsRecordEventMock: vi.fn().mockResolvedValue(undefined),
  cloudJobsStampMilestoneMock: vi.fn().mockResolvedValue(undefined),
  cloudJobsSyncActingUserIdMock: vi.fn().mockResolvedValue('unchanged'),
  cloudJobsSetHarnessSessionIdMock: vi.fn().mockResolvedValue(undefined),
  cloudJobsUpdateRuntimeStateMock: vi.fn().mockResolvedValue({ updated: true }),
  cloudJobsUpdateMock: vi.fn().mockResolvedValue(undefined),
  createHarnessMock: vi.fn().mockResolvedValue({
    harness: {},
    getSubprocess: vi.fn(() => ({})),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  }),
  createInitialTaskStateMock: vi.fn(() => ({
    sessionId: undefined,
    cancelTriggeredAt: undefined,
    lastMessageAt: undefined,
    taskFinishedAt: undefined,
    taskAbortedAt: undefined,
  })),
  createServerMock: vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
  drainSlackMessagesMock: vi
    .fn()
    .mockResolvedValue({ resumed: false, reason: 'no_pending_messages' }),
  existsSyncMock: vi.fn(),
  getDecryptedKeyMock: vi.fn().mockResolvedValue(undefined),
  mockEvaluateFeatureFlag: vi.fn().mockResolvedValue(false),
  getMcpServerConfigsMock: vi.fn().mockResolvedValue({ servers: {} }),
  harnessManagerInstances: [] as FakeHarnessManager[],
  hasActiveInstallationMock: vi.fn().mockResolvedValue(false),
  isOrgEnabledMock: vi.fn().mockResolvedValue(false),
  resolvePackagedSkillsFolderMock: vi.fn(() => 'standard'),
  resolveStatusMock: vi.fn(() => 'idle'),
  syncRuntimeGitAuthorMock: vi.fn().mockResolvedValue(undefined),
  startPollingMock: vi.fn(),
  stopPollingMock: vi.fn(),
  waitForShutdownMock: vi.fn(),
  waitForExternalSleepActionMock: vi
    .fn()
    .mockResolvedValue({ claimed: false, completed: false }),
  mkdirSyncMock: vi.fn(),
  recordSandboxPromptSlackTurnStartMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  installZeroCliMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

type FakeHarnessManager = EventEmitter & {
  currentIsConnected: boolean;
  currentSleepAt: number | null;
  callbacks?: {
    onStart?: (taskId: string) => Promise<void>;
    onExit?: () => Promise<void>;
  };
  getStatus: ReturnType<typeof vi.fn>;
  resumeTask: ReturnType<typeof vi.fn>;
  sendFollowUpPrompt: ReturnType<typeof vi.fn>;
  startNewTask: ReturnType<typeof vi.fn>;
  initializeWithoutPrompt: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

vi.mock('@roomote/auth/client', () => ({
  validateToken: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS: [
    'capture-visual-proof',
    'create-draft-pr',
    'create-pr',
    'explain-repo-code',
    'fix-pr',
    'implement-changes',
    'plan-repo-implementation',
    'push',
    'review-code',
    'review-and-fix',
    'triage-sentry',
  ],
  ROOMOTE_COMPACT_PROMPT: 'Default compaction prompt.',
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      done: cloudJobsDoneMock,
      recordEvent: cloudJobsRecordEventMock,
      stampMilestone: cloudJobsStampMilestoneMock,
      setHarnessSessionId: cloudJobsSetHarnessSessionIdMock,
      syncActingUserId: cloudJobsSyncActingUserIdMock,
      update: cloudJobsUpdateMock,
      updateRuntimeState: cloudJobsUpdateRuntimeStateMock,
    },
    linearInstallations: {
      drainLinearMessages: vi.fn(),
      hasActiveInstallation: hasActiveInstallationMock,
    },
    featureFlags: {
      evaluate: mockEvaluateFeatureFlag,
    },
    mcpConnections: {
      getMcpServerConfigs: getMcpServerConfigsMock,
      isOrgEnabled: isOrgEnabledMock,
    },
    slackInstallations: {
      drainSlackMessages: drainSlackMessagesMock,
    },
    userApiKeys: {
      getDecryptedKey: getDecryptedKeyMock,
    },
  },
}));

vi.mock('../../sandbox-server', () => ({
  HarnessManager: class FakeHarnessManager extends EventEmitter {
    currentIsConnected = true;
    currentSleepAt: number | null = null;
    callbacks?: {
      onStart?: (taskId: string) => Promise<void>;
      onExit?: () => Promise<void>;
    };
    getStatus = vi.fn(() => ({
      isConnected: this.currentIsConnected,
      phase: 'running',
      sessionId: undefined,
    }));
    resumeTask = vi.fn();
    sendFollowUpPrompt = vi.fn(() => true);
    startNewTask = vi.fn();
    initializeWithoutPrompt = vi.fn();
    cancelTask = vi.fn();
    dispose = vi.fn();

    constructor(config?: {
      callbacks?: {
        onStart?: (taskId: string) => Promise<void>;
        onExit?: () => Promise<void>;
      };
    }) {
      super();
      this.callbacks = config?.callbacks;
      harnessManagerInstances.push(this as FakeHarnessManager);
    }

    getSleepAt() {
      return this.currentSleepAt;
    }

    waitForShutdown() {
      return waitForShutdownMock();
    }
  },
  createInitialTaskState: createInitialTaskStateMock,
  createServer: createServerMock,
}));

vi.mock('../polling', () => ({
  startPolling: startPollingMock,
  stopPolling: stopPollingMock,
}));

vi.mock('../subprocess', () => ({
  awaitSubprocess: awaitSubprocessMock,
}));

vi.mock('../wait-for-external-sleep-action', () => ({
  waitForExternalSleepAction: waitForExternalSleepActionMock,
}));

vi.mock('../resolve-status', () => ({
  resolveStatus: resolveStatusMock,
}));

vi.mock('../completion', () => ({
  getDefaultKeepaliveMs: vi.fn(() => 60_000),
}));

vi.mock('../../commands/setup/agent-clis', () => ({
  installZeroCli: installZeroCliMock,
}));

vi.mock('../agent-home', () => ({
  activateSkillsFolder: activateSkillsFolderMock,
  readConfiguredSkillsFolder: vi.fn(() => undefined),
  resolvePackagedSkillsFolder: resolvePackagedSkillsFolderMock,
}));

vi.mock('../create-harness', () => ({
  createHarness: createHarnessMock,
}));

vi.mock('../sandbox-instruction', () => ({
  buildSandboxInstruction: buildSandboxInstructionMock,
}));

vi.mock('../../lib/sync-runtime-git-author', () => ({
  syncRuntimeGitAuthor: syncRuntimeGitAuthorMock,
}));

vi.mock('../../sandbox-server/procedures/slackReplyTurnTracking', () => ({
  recordSandboxPromptSlackTurnStart: recordSandboxPromptSlackTurnStartMock,
}));

import { CloudTaskStatus, CloudTaskType } from '@roomote/types';

import { getDefaultKeepaliveMs } from '../completion';
import { runTask } from '../run-task';

describe('runTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harnessManagerInstances.length = 0;
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    recordSandboxPromptSlackTurnStartMock.mockReset();

    createHarnessMock.mockResolvedValue({
      harness: {},
      getSubprocess: vi.fn(() => ({})),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    createServerMock.mockReturnValue({
      close: vi.fn().mockResolvedValue(undefined),
    });
    createInitialTaskStateMock.mockReturnValue({
      sessionId: undefined,
      cancelTriggeredAt: undefined,
      lastMessageAt: undefined,
      taskFinishedAt: undefined,
      taskAbortedAt: undefined,
    });
    resolveStatusMock.mockReturnValue(CloudTaskStatus.Idle);
    waitForExternalSleepActionMock.mockResolvedValue({
      claimed: false,
      completed: false,
    });
    waitForShutdownMock.mockResolvedValue({
      sessionId: undefined,
      cancelTriggeredAt: undefined,
      lastMessageAt: undefined,
      taskFinishedAt: Date.now(),
      taskAbortedAt: undefined,
    });
    hasActiveInstallationMock.mockResolvedValue(false);
    isOrgEnabledMock.mockResolvedValue(false);
    getDecryptedKeyMock.mockResolvedValue(undefined);
    mockEvaluateFeatureFlag.mockResolvedValue(false);
    getMcpServerConfigsMock.mockResolvedValue({ servers: {} });
    drainSlackMessagesMock.mockReset();
    drainSlackMessagesMock.mockResolvedValue({
      resumed: false,
      reason: 'no_pending_messages',
    });
    cloudJobsStampMilestoneMock.mockReset();
    cloudJobsStampMilestoneMock.mockResolvedValue(undefined);
    cloudJobsSyncActingUserIdMock.mockReset();
    cloudJobsSyncActingUserIdMock.mockResolvedValue('unchanged');
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    syncRuntimeGitAuthorMock.mockReset();
    syncRuntimeGitAuthorMock.mockResolvedValue(undefined);
  });

  it('does not pass a system prompt into the OpenCode harness', async () => {
    await runTask({
      cloudJob: {
        id: 150,
        taskId: 'task-150',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: 'Be terse and calm.',
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock.mock.calls[0]?.[0]).toEqual(
      expect.not.objectContaining({
        systemPromptContent: expect.anything(),
      }),
    );
  });

  it('drops untrusted harness home overrides from the OpenCode runtime environment', async () => {
    await runTask({
      cloudJob: {
        id: 151,
        taskId: 'task-151',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
          UNTRUSTED_HARNESS_HOME: '/tmp/custom-harness-home',
          UNTRUSTED_HARNESS_CHILD_HOME: '/tmp/custom-harness-child-home',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          UNTRUSTED_HARNESS_HOME: '/tmp/custom-harness-home',
          UNTRUSTED_HARNESS_CHILD_HOME: '/tmp/custom-harness-child-home',
        }),
      }),
    );
  });

  it('passes the built-in Roomote MCP task env into harness startup', async () => {
    await runTask({
      cloudJob: {
        id: 152,
        taskId: 'task-152',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpTaskEnv: expect.objectContaining({
          ROOMOTE_CLOUD_TOKEN: 'cloud-token',
          ROOMOTE_APP_URL: 'https://api.example.test',
          ROOMOTE_PLATFORM_API_URL: 'https://web.example.test',
          ROOMOTE_TASK_ID: 'task-152',
        }),
      }),
    );
  });

  it('stamps runtimeTaskStartedAt when the harness accepts the task', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);

    await runTask({
      cloudJob: {
        id: 105,
        taskId: 'task-105',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: { onStart },
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const manager = harnessManagerInstances[0]!;

    await manager.callbacks?.onStart?.('session-105');

    expect(cloudJobsSetHarnessSessionIdMock).toHaveBeenCalledWith({
      cloudJobId: 105,
      harnessSessionId: 'session-105',
    });
    expect(cloudJobsStampMilestoneMock).toHaveBeenCalledWith({
      cloudJobId: 105,
      field: 'runtimeTaskStartedAt',
    });
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 105, taskId: 'task-105' }),
      'session-105',
      {},
    );
  });

  it('passes the background subagents flag into the runtime env when enabled for the org', async () => {
    mockEvaluateFeatureFlag.mockImplementation(async (flag: string) => {
      return flag === 'BackgroundSubagents';
    });

    await runTask({
      cloudJob: {
        id: 103,
        taskId: 'task-103',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith('BackgroundSubagents');
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: '1',
        }),
      }),
    );
  });

  it('passes the plan mode flag into the runtime env when enabled for the org', async () => {
    mockEvaluateFeatureFlag.mockImplementation(async (flag: string) => {
      return flag === 'PlanMode';
    });

    await runTask({
      cloudJob: {
        id: 106,
        taskId: 'task-106',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(mockEvaluateFeatureFlag).toHaveBeenCalledWith('PlanMode');
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_PLAN_MODE: 'true',
        }),
      }),
    );
  });

  it('does not set the plan mode env when the flag is disabled', async () => {
    mockEvaluateFeatureFlag.mockResolvedValue(false);

    await runTask({
      cloudJob: {
        id: 107,
        taskId: 'task-107',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          ROOMOTE_PLAN_MODE: expect.anything(),
        }),
      }),
    );
  });

  it('does not set the background subagents env when the flag is disabled', async () => {
    mockEvaluateFeatureFlag.mockResolvedValue(false);

    await runTask({
      cloudJob: {
        id: 104,
        taskId: 'task-104',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: expect.anything(),
        }),
      }),
    );
  });

  it('always enables the terminal runtime env and sandbox server', async () => {
    await runTask({
      cloudJob: {
        id: 110,
        taskId: 'task-110',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_TASK_TERMINAL: 'true',
        }),
      }),
    );
    expect(createServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTerminal: true,
      }),
    );
  });

  it('keeps the task terminal enabled while clearing only reserved reply context env vars', async () => {
    mockEvaluateFeatureFlag.mockImplementation(async () => false);

    await runTask({
      cloudJob: {
        id: 104,
        taskId: 'task-104',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {
        ROOMOTE_TASK_TERMINAL: 'true',
        ROOMOTE_UNTRUSTED_HARNESS_MODE: 'true',
      },
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const harnessCall = createHarnessMock.mock.calls[0]?.[0];
    expect(harnessCall?.runtimeEnv).toEqual(
      expect.objectContaining({
        ROOMOTE_TASK_TERMINAL: 'true',
      }),
    );
    expect(harnessCall?.mcpTaskEnv).toEqual(
      expect.objectContaining({
        ROOMOTE_TASK_TERMINAL: 'true',
      }),
    );
    expect(createServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTerminal: true,
      }),
    );
  });

  it('always passes Slack reply satisfaction state into the MCP task env for Slack tasks', async () => {
    await runTask({
      cloudJob: {
        id: 1061,
        taskId: 'task-1061',
        type: CloudTaskType.SlackAppMention,
        harness: 'opencode-server',
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
          text: 'hello',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpTaskEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
            '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json',
        }),
      }),
    );
  });

  it('passes Slack thread context into the runtime env for proof uploads', async () => {
    await runTask({
      cloudJob: {
        id: 107,
        taskId: 'task-107',
        type: CloudTaskType.SlackAppMention,
        harness: 'opencode-server',
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
        ports: [],
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
        }),
        mcpTaskEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
        }),
      }),
    );
  });

  it('passes Slack thread context into the runtime env for coerced legacy proof uploads', async () => {
    await runTask({
      cloudJob: {
        id: 108,
        taskId: 'task-108',
        type: CloudTaskType.SlackAppMention,
        harness: 'opencode-server',
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
        ports: [],
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
        }),
        mcpTaskEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
        }),
      }),
    );
  });

  it('initializes Slack reply satisfaction state for Slack-originated tasks', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456);

    try {
      await runTask({
        cloudJob: {
          id: 105,
          taskId: 'task-105',
          type: CloudTaskType.SlackAppMention,
          harness: 'opencode-server',
          slackThreadTs: '111.222',
          payload: {
            channel: 'C123',
            thread_ts: '111.222',
          },
          result: null,
        } as never,
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as never,
        harnessSessionId: undefined,
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        } as never,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const stateFilePath =
      '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json';
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      '/tmp/workspace/.roomote-runtime-home/.config/opencode',
      {
        recursive: true,
      },
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      stateFilePath,
      JSON.stringify({
        startedAtMs: 123_456,
        currentTurnRequiresInitialAck: true,
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 123_456,
        currentTurnReactionsAllowed: false,
      }),
      'utf8',
    );
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        }),
        mcpTaskEnv: expect.objectContaining({
          ROOMOTE_SLACK_CHANNEL: 'C123',
          ROOMOTE_SLACK_THREAD_TS: '111.222',
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        }),
      }),
    );
  });

  it('initializes SnapshotResume Slack reply satisfaction from the origin message when present', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(234_567);

    try {
      await runTask({
        cloudJob: {
          id: 106,
          taskId: 'task-106',
          type: CloudTaskType.SnapshotResume,
          harness: 'opencode-server',
          slackThreadTs: '111.000',
          payload: {
            slackChannel: 'C123',
            slackOriginMessageTs: '111.333',
            sourceSnapshotId: 'snap-1',
          },
          result: null,
        } as never,
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as never,
        harnessSessionId: 'session-106',
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        } as never,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const stateFilePath =
      '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json';
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      stateFilePath,
      JSON.stringify({
        startedAtMs: 234_567,
        currentTurnRequiresInitialAck: true,
        currentTurnMessageTs: '111.333',
        currentTurnStartedAtMs: 234_567,
        currentTurnReactionsAllowed: true,
      }),
      'utf8',
    );
  });

  it('initializes Telegram reply satisfaction state without first-turn reactions', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(456_789);

    try {
      await runTask({
        cloudJob: {
          id: 107,
          taskId: 'task-107',
          type: CloudTaskType.StandardTask,
          harness: 'opencode-server',
          slackThreadTs: null,
          payload: {
            repo: 'org/repo',
            description: 'do the thing',
            communicationProvider: 'telegram',
            communicationChannelId: '8846357662',
            communicationMessageId: '456',
          },
          result: null,
        } as never,
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as never,
        harnessSessionId: undefined,
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        } as never,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const stateFilePath =
      '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json';
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      stateFilePath,
      JSON.stringify({
        startedAtMs: 456_789,
        currentTurnRequiresInitialAck: true,
        currentTurnMessageTs: '456',
        currentTurnStartedAtMs: 456_789,
        // Chat-launched first turns require a real reply, not a reaction.
        currentTurnReactionsAllowed: false,
      }),
      'utf8',
    );
  });

  it('initializes Teams reply satisfaction state without first-turn reactions', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(567_890);

    try {
      await runTask({
        cloudJob: {
          id: 108,
          taskId: 'task-108',
          type: CloudTaskType.StandardTask,
          harness: 'opencode-server',
          slackThreadTs: null,
          payload: {
            repo: 'org/repo',
            description: 'do the thing',
            communicationProvider: 'teams',
            communicationChannelId: '19:conversation@thread.v2',
            communicationThreadId: 'activity-root',
            communicationMessageId: 'activity-root',
          },
          result: null,
        } as never,
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as never,
        harnessSessionId: undefined,
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        } as never,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const stateFilePath =
      '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json';
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      stateFilePath,
      JSON.stringify({
        startedAtMs: 567_890,
        currentTurnRequiresInitialAck: true,
        currentTurnMessageTs: 'activity-root',
        currentTurnStartedAtMs: 567_890,
        currentTurnReactionsAllowed: false,
      }),
      'utf8',
    );
  });

  it('marks late-bound automation execution tasks as requiring a terminal closeout', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(345_678);

    try {
      await runTask({
        cloudJob: {
          id: 107,
          taskId: 'task-107',
          type: CloudTaskType.StandardTask,
          harness: 'opencode-server',
          slackThreadTs: null,
          payload: {
            repo: 'acme/app',
            slackChannel: 'C123',
            channel: 'C123',
            automationWorkItemId: 'work-item-1',
          },
          result: null,
        } as never,
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as never,
        harnessSessionId: 'session-107',
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        } as never,
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json',
      JSON.stringify({
        startedAtMs: 345_678,
        currentTurnRequiresInitialAck: false,
        requiresTerminalCloseoutWithoutTurn: true,
      }),
      'utf8',
    );
  });

  it('checks Slack drain during sleep fallback when the worker started before thread ts was persisted', async () => {
    waitForExternalSleepActionMock.mockResolvedValueOnce({
      claimed: true,
      completed: false,
    });

    await runTask({
      cloudJob: {
        id: 109,
        taskId: 'task-109',
        type: CloudTaskType.SuggestedTasks,
        harness: 'opencode-server',
        slackThreadTs: null,
        payload: {
          slackChannel: 'C123',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(drainSlackMessagesMock).toHaveBeenCalledWith({
      cloudJobId: 109,
    });
  });

  it('passes task type into the keepalive fallback when keepaliveMs is missing', async () => {
    await runTask({
      cloudJob: {
        id: 1091,
        taskId: 'task-1091',
        type: CloudTaskType.GithubPrReview,
        harness: 'opencode-server',
        keepaliveMs: null,
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(getDefaultKeepaliveMs).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: CloudTaskType.GithubPrReview,
      }),
    );
  });

  it('passes a task-scoped agent-browser session into the runtime env', async () => {
    await runTask({
      cloudJob: {
        id: 101,
        taskId: 'task-101',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {
        FOO: 'from-payload',
      },
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledTimes(1);
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          AGENT_BROWSER_SESSION: 'task-101',
          ROOMOTE_TASK_ID: 'task-101',
        }),
        mcpTaskEnv: expect.objectContaining({
          AGENT_BROWSER_SESSION: 'task-101',
        }),
      }),
    );
  });

  it('fetches org-scoped MCP servers even when the cloud job has no user id', async () => {
    getMcpServerConfigsMock.mockResolvedValueOnce({
      servers: {
        snowflake: {
          url: 'https://api.example.test/api/mcp/snowflake',
        },
      },
    });

    await runTask({
      cloudJob: {
        id: 106,
        taskId: 'task-106',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(getMcpServerConfigsMock).toHaveBeenCalledTimes(1);
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: expect.objectContaining({
          userMcpServers: {
            snowflake: {
              url: 'https://api.example.test/api/mcp/snowflake',
            },
          },
        }),
      }),
    );
  });

  it('passes the proof browser target to the harness when the environment exposes a browser surface', async () => {
    await runTask({
      cloudJob: {
        id: 152,
        taskId: 'task-152',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {
        ROOMOTE_STORYBOOK_HOST: 'http://localhost:6006',
      },
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
        ports: [
          {
            name: 'STORYBOOK',
            port: 6006,
            initial_path: '/?path=/story/example',
          },
        ],
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const proofConfigCall = writeFileSyncMock.mock.calls.find(
      ([targetPath]) => targetPath === '/tmp/proof-capture-config.json',
    );

    expect(proofConfigCall).toBeUndefined();
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          ROOMOTE_PROOF_BROWSER_TARGET: 'http://localhost:3000/auth/dev-login',
        }),
      }),
    );
  });

  it('does not expose removed proof runner flags when requested', async () => {
    await runTask({
      cloudJob: {
        id: 153,
        taskId: 'task-153',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          ROOMOTE_PRE_PUSH_REVIEW_LOOP: 'true',
          ROOMOTE_NATIVE_PROOF_CAPTURE: 'true',
        }),
      }),
    );
  });

  it('does not expose removed proof runner flags for coerced legacy jobs', async () => {
    await runTask({
      cloudJob: {
        id: 154,
        taskId: 'task-154',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          ROOMOTE_PRE_PUSH_REVIEW_LOOP: 'true',
          ROOMOTE_NATIVE_PROOF_CAPTURE: 'true',
        }),
      }),
    );
  });

  it('does not pass a proof browser target when the environment lacks a browser surface', async () => {
    await runTask({
      cloudJob: {
        id: 155,
        taskId: 'task-155',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions: undefined,
      styleGuidance: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          ROOMOTE_PROOF_BROWSER_TARGET: expect.any(String),
        }),
      }),
    );
  });

  it('queues a deferred resume prompt from SnapshotResume payloads', async () => {
    cloudJobsSyncActingUserIdMock.mockResolvedValue('updated');
    const onStart = vi.fn().mockResolvedValue(undefined);
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    createHarnessMock.mockResolvedValueOnce({
      harness: {
        requestReconnect,
      },
      getSubprocess: vi.fn(() => ({})),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    getMcpServerConfigsMock.mockResolvedValueOnce({
      servers: {
        supabase: {
          url: 'https://api.example.test/api/mcp/supabase',
        },
      },
    });

    await runTask({
      cloudJob: {
        id: 303,
        taskId: 'task-303',
        type: CloudTaskType.SnapshotResume,
        harness: 'opencode-server',
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
          sourceSnapshotId: 'snap-303',
          sourceCloudJobId: 302,
          slackOriginMessageTs: '111.222',
          resumePrompt: 'Tell me what this PR is about.',
          resumePromptSource: 'web',
          resumePromptClientMessageId: 'client-303',
          resumePromptUserId: 'user-2',
          resumePromptImages: ['data:image/png;base64,abc'],
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: { onStart },
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: 'resume-session-303',
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
        })),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    const manager = harnessManagerInstances[0]!;

    expect(manager.resumeTask).toHaveBeenCalledWith('resume-session-303');
    expect(cloudJobsStampMilestoneMock).toHaveBeenCalledWith({
      cloudJobId: 303,
      field: 'runtimeTaskStartedAt',
    });
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 303, taskId: 'task-303' }),
      'resume-session-303',
      {},
    );
    expect(cloudJobsSyncActingUserIdMock).toHaveBeenCalledWith({
      cloudJobId: 303,
      newUserId: 'user-2',
    });
    expect(syncRuntimeGitAuthorMock).toHaveBeenCalledWith({
      cloudJobId: 303,
      workingDirectory: '/tmp/workspace',
    });
    expect(getMcpServerConfigsMock).toHaveBeenCalledTimes(2);
    expect(requestReconnect).toHaveBeenCalledWith({
      reason: 'actor-scoped MCP refresh for user-2',
      afterCurrentTurn: false,
    });
    expect(startPollingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          phase: 'waiting_for_prompt',
          sessionId: 'resume-session-303',
        }),
      }),
    );
    expect(cloudJobsUpdateMock).toHaveBeenCalledWith({
      id: 303,
      result: expect.objectContaining({
        runtimeTaskId: 'resume-session-303',
        deferredResumePromptAccepted: true,
        deferredResumePromptAcceptedAt: expect.any(String),
      }),
    });
    expect(manager.sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Tell me what this PR is about.',
      images: ['data:image/png;base64,abc'],
      autoSteerWhenQueued: true,
      source: 'web',
      clientMessageId: 'client-303',
      userId: 'user-2',
    });
    expect(recordSandboxPromptSlackTurnStartMock).toHaveBeenCalledWith({
      clientMessageId: 'client-303',
      source: 'web',
      stateFilePath:
        '/tmp/workspace/.roomote-runtime-home/.config/opencode/roomote-slack-reply-satisfaction.json',
    });
  });

  it('does not resume a task if cancellation is requested during startup', async () => {
    const cancelController = new AbortController();
    const onStart = vi.fn();

    const runTaskPromise = runTask({
      cloudJob: {
        id: 304,
        taskId: 'task-304',
        type: CloudTaskType.SnapshotResume,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: { onStart },
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      cancelSignal: cancelController.signal,
      harnessSessionId: 'resume-session-304',
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
        })),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    cancelController.abort(new Error('background environment setup failed'));

    await expect(runTaskPromise).resolves.toEqual({
      status: CloudTaskStatus.Canceled,
      error: 'Task aborted',
    });

    const manager = harnessManagerInstances.at(0);
    expect(manager?.resumeTask).not.toHaveBeenCalled();
    expect(manager?.startNewTask).not.toHaveBeenCalled();
    expect(manager?.initializeWithoutPrompt).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(startPollingMock).not.toHaveBeenCalled();
    expect(waitForShutdownMock).not.toHaveBeenCalled();
  });

  it('passes explicit workflow phases through deferred resume prompts', async () => {
    cloudJobsSyncActingUserIdMock.mockResolvedValue('updated');
    const onStart = vi.fn().mockResolvedValue(undefined);
    createHarnessMock.mockResolvedValueOnce({
      harness: {
        requestReconnect: vi.fn().mockResolvedValue(undefined),
      },
      getSubprocess: vi.fn(() => ({})),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    getMcpServerConfigsMock.mockResolvedValueOnce({ servers: {} });

    await runTask({
      cloudJob: {
        id: 304,
        taskId: 'task-304',
        type: CloudTaskType.SnapshotResume,
        harness: 'opencode-server',
        payload: {
          sourceSnapshotId: 'snap-304',
          sourceCloudJobId: 303,
          resumePrompt: '$review-code\nTell me what this PR is about.',
          resumePromptSource: 'web',
          resumePromptUserId: 'user-2',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: { onStart },
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: 'resume-session-304',
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
        })),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    const manager = harnessManagerInstances.at(-1)!;
    expect(manager.sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: '$review-code\nTell me what this PR is about.',
      workflowPhase: 'review-code',
      autoSteerWhenQueued: true,
      source: 'web',
      userId: 'user-2',
    });
  });

  it('does not compare queued actor-scoped MCP state when actingUserId sync fails', async () => {
    cloudJobsSyncActingUserIdMock.mockRejectedValueOnce(
      new Error('sync failed'),
    );

    await runTask({
      cloudJob: {
        id: 404,
        taskId: 'task-404',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    const prepareQueuedPromptActorScope =
      createHarnessMock.mock.calls[0]?.[0].prepareQueuedPromptActorScope;

    expect(prepareQueuedPromptActorScope).toBeTypeOf('function');

    await expect(prepareQueuedPromptActorScope?.('user-2')).resolves.toEqual({
      shouldReconnect: false,
      shouldBlockPrompt: true,
      reason:
        'actor-scoped turn delivery is blocked until actingUserId can be synchronized',
    });
    expect(getMcpServerConfigsMock).toHaveBeenCalledTimes(1);
    expect(getDecryptedKeyMock).not.toHaveBeenCalled();
    expect(syncRuntimeGitAuthorMock).not.toHaveBeenCalled();
  });

  it('allows queued actor-scoped prompts to continue when the same-actor refresh recheck fails', async () => {
    getMcpServerConfigsMock
      .mockResolvedValueOnce({
        servers: {
          notion: {
            url: 'https://api.example.test/api/mcp/notion',
          },
        },
      })
      .mockRejectedValueOnce(new Error('temporary failure'));

    await runTask({
      cloudJob: {
        id: 405,
        taskId: 'task-405',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        userId: 'user-2',
        actingUserId: 'user-2',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    const prepareQueuedPromptActorScope =
      createHarnessMock.mock.calls[0]?.[0].prepareQueuedPromptActorScope;

    await expect(prepareQueuedPromptActorScope?.('user-2')).resolves.toEqual({
      shouldReconnect: false,
      reason:
        'actor-scoped MCP refresh failed for the current actor; continuing with existing MCP state',
    });
  });

  it('retries blocked deferred resume prompts instead of marking them rejected immediately', async () => {
    vi.useFakeTimers();
    let resolveWaitForShutdown:
      | ((value: {
          sessionId: string | undefined;
          cancelTriggeredAt: undefined;
          lastMessageAt: undefined;
          taskFinishedAt: number;
          taskAbortedAt: undefined;
        }) => void)
      | undefined;
    let resolveHarnessCreated:
      | ((value: FakeHarnessManager) => void)
      | undefined;
    const waitForShutdownPromise = new Promise<{
      sessionId: string | undefined;
      cancelTriggeredAt: undefined;
      lastMessageAt: undefined;
      taskFinishedAt: number;
      taskAbortedAt: undefined;
    }>((resolve) => {
      resolveWaitForShutdown = resolve;
    });
    const harnessCreatedPromise = new Promise<FakeHarnessManager>((resolve) => {
      resolveHarnessCreated = resolve;
    });
    const requestReconnect = vi.fn().mockResolvedValue(undefined);

    waitForShutdownMock.mockReturnValueOnce(waitForShutdownPromise);
    cloudJobsSyncActingUserIdMock.mockResolvedValue('updated');
    getMcpServerConfigsMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        servers: {
          supabase: {
            url: 'https://api.example.test/api/mcp/supabase',
          },
        },
      });
    createHarnessMock.mockImplementationOnce(async () => {
      return {
        harness: {
          requestReconnect,
        },
        getSubprocess: vi.fn(() => ({})),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      };
    });
    createServerMock.mockImplementationOnce(() => {
      resolveHarnessCreated?.(harnessManagerInstances[0]!);

      return {
        close: vi.fn().mockResolvedValue(undefined),
      };
    });

    const runTaskPromise = runTask({
      cloudJob: {
        id: 406,
        taskId: 'task-406',
        type: CloudTaskType.SnapshotResume,
        harness: 'opencode-server',
        userId: 'owner-user',
        actingUserId: 'owner-user',
        payload: {
          resumePrompt: 'Tell me what this PR is about.',
          resumePromptSource: 'github',
          resumePromptUserId: 'user-2',
        },
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: 'resume-session-406',
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    try {
      const harnessManager = await harnessCreatedPromise;

      expect(harnessManager.sendFollowUpPrompt).not.toHaveBeenCalled();
      expect(cloudJobsUpdateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          id: 406,
          result: expect.objectContaining({
            deferredResumePromptAccepted: false,
          }),
        }),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(requestReconnect).toHaveBeenCalledWith({
        reason: 'actor-scoped MCP refresh for user-2',
        afterCurrentTurn: false,
      });
      expect(harnessManager.sendFollowUpPrompt).toHaveBeenCalledWith({
        prompt: 'Tell me what this PR is about.',
        autoSteerWhenQueued: true,
        source: 'github',
        userId: 'user-2',
      });
      expect(cloudJobsUpdateMock).toHaveBeenCalledWith({
        id: 406,
        result: expect.objectContaining({
          deferredResumePromptAccepted: true,
          deferredResumePromptAcceptedAt: expect.any(String),
        }),
      });

      resolveWaitForShutdown?.({
        sessionId: undefined,
        cancelTriggeredAt: undefined,
        lastMessageAt: undefined,
        taskFinishedAt: Date.now(),
        taskAbortedAt: undefined,
      });

      await runTaskPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes legacy jobs without a persisted harness through opencode-server', async () => {
    await runTask({
      cloudJob: {
        id: 203,
        taskId: 'task-203',
        type: CloudTaskType.StandardTask,
        harness: undefined,
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    expect(createServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codingHarness: 'opencode-server',
      }),
    );
  });

  it('starts the OpenCode harness in the worker runtime', async () => {
    await runTask({
      cloudJob: {
        id: 204,
        taskId: 'task-204',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessType: 'opencode-server',
      }),
    );
    expect(createServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codingHarness: 'opencode-server',
      }),
    );
  });

  it('coerces an explicit legacy direct harness into the sandbox server', async () => {
    await runTask({
      cloudJob: {
        id: 204,
        taskId: 'task-204',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      workerEnv: {
        buildUserFacingEnv: vi.fn(() => ({})),
        roomoteAppUrl: 'http://localhost:3000',
        trpcUrl: 'http://localhost:3001',
        authToken: 'auth-token',
        appEnv: 'test',
        setRuntimeEnv: vi.fn(),
      } as never,
    });

    expect(createServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codingHarness: 'opencode-server',
      }),
    );
  });

  it('drops headed browser override env vars from the sanitized runtime env', async () => {
    await runTask({
      cloudJob: {
        id: 102,
        taskId: 'task-102',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
          DISPLAY: ':1',
          AGENT_BROWSER_ARGS: '--disable-infobars',
          AGENT_BROWSER_HEADED: '1',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledTimes(1);
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          DISPLAY: ':1',
        }),
      }),
    );
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.not.objectContaining({
          AGENT_BROWSER_ARGS: '--disable-infobars',
          AGENT_BROWSER_HEADED: '1',
        }),
      }),
    );
  });

  it('injects environment instructions into developer instructions for blank sessions', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 150,
        taskId: 'task-150',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: 'Run tests before finishing',
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const expectedInstructions = [
      '<environment-instructions>',
      'Run tests before finishing',
      'Sandbox details',
      '</environment-instructions>',
    ].join('\n');

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: expectedInstructions,
      }),
    );

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager?.initializeWithoutPrompt).toHaveBeenCalledTimes(1);
    expect(harnessManager?.startNewTask).not.toHaveBeenCalled();
  });

  it('injects environment instructions into developer instructions for non-blank starts', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 151,
        taskId: 'task-151',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: 'Fix the failing test',
      harnessInstructions: undefined,
      agentInstructions: 'Run tests before finishing',
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const expectedInstructions = [
      '<environment-instructions>',
      'Run tests before finishing',
      'Sandbox details',
      '</environment-instructions>',
    ].join('\n');

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: expectedInstructions,
      }),
    );

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager?.startNewTask).toHaveBeenCalledWith({
      prompt: 'Fix the failing test',
      images: undefined,
      visibleInTranscript: false,
    });
    expect(harnessManager?.initializeWithoutPrompt).not.toHaveBeenCalled();
  });

  it('does not start the initial prompt if cancellation is requested during startup', async () => {
    const cancelController = new AbortController();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };

    const runTaskPromise = runTask({
      cloudJob: {
        id: 151,
        taskId: 'task-151',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: 'Fix the failing test',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: logger as never,
      cancelSignal: cancelController.signal,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    cancelController.abort(new Error('background environment setup failed'));

    await expect(runTaskPromise).resolves.toEqual({
      status: CloudTaskStatus.Canceled,
      error: 'Task aborted',
    });

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager?.startNewTask).not.toHaveBeenCalled();
    expect(harnessManager?.resumeTask).not.toHaveBeenCalled();
    expect(harnessManager?.initializeWithoutPrompt).not.toHaveBeenCalled();
    expect(startPollingMock).not.toHaveBeenCalled();
    expect(waitForShutdownMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping initial task start'),
    );
  });

  it('preserves subprocess cleanup if cancellation is requested during startup', async () => {
    const cancelController = new AbortController();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const subprocess = {};
    let currentSubprocess: object | null = subprocess;
    const harnessDispose = vi.fn(() => {
      currentSubprocess = null;
    });

    createHarnessMock.mockResolvedValueOnce({
      harness: {
        dispose: harnessDispose,
      },
      getSubprocess: vi.fn(() => currentSubprocess),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });

    const runTaskPromise = runTask({
      cloudJob: {
        id: 153,
        taskId: 'task-153',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: 'Fix the failing test',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: logger as never,
      cancelSignal: cancelController.signal,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    cancelController.abort(new Error('background environment setup failed'));

    await expect(runTaskPromise).resolves.toEqual({
      status: CloudTaskStatus.Canceled,
      error: 'Task aborted',
    });

    expect(harnessDispose).toHaveBeenCalled();
    expect(awaitSubprocessMock).toHaveBeenCalledWith({
      subprocess,
      controller: expect.any(AbortController),
      logger,
    });
  });

  it('maps requested work kind to the initial workflow phase before starting the harness', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 152,
        taskId: 'task-152',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        requestedWorkKind: 'implement',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: 'Fix the failing test',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt: 'Fix the failing test',
      images: undefined,
      workflowPhase: 'implement-changes',
      visibleInTranscript: false,
    });
  });

  it('injects workspace readiness warnings into developer and child agent instructions', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 1515,
        taskId: 'task-1515',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: 'Run tests before finishing',
      workspaceReadinessWarnings: [
        'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
      ],
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const expectedInstructions = [
      '<environment-instructions>',
      'Run tests before finishing',
      '',
      'Workspace readiness notice:',
      'This task is starting before workspace readiness is fully settled. Some environment setup steps may still be running or may have reported warnings.',
      'Acknowledge this politely if it affects the user request, and do not assume the environment is fully configured.',
      '- Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
      'Sandbox details',
      '</environment-instructions>',
    ].join('\n');

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: expectedInstructions,
      }),
    );
  });

  it('keeps org-wide instructions in the parent startup prompt only', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 152,
        taskId: 'task-152',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      orgAgentInstructions:
        'Use short status updates unless the task is blocked.',
      agentInstructions: 'Run tests before finishing.',
      environmentConfig: {
        initialUrl: 'http://localhost:3000/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const expectedInstructions = [
      '<environment-instructions>',
      'Organization-wide agent behavior:',
      'Use short status updates unless the task is blocked.',
      '',
      'Environment-specific agent instructions:',
      'Run tests before finishing.',
      'Sandbox details',
      '</environment-instructions>',
    ].join('\n');

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: expectedInstructions,
      }),
    );
  });

  it('does not inject repo-local skill inventory into developer instructions', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 1521,
        taskId: 'task-1521',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'docs-maintenance',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/docs-maintenance/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/docs-maintenance',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
      ],
      agentInstructions: 'Run tests before finishing.',
      environmentConfig: {} as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const expectedInstructions = [
      'Workflow instructions',
      '',
      '<environment-instructions>',
      'Run tests before finishing.',
      'Sandbox details',
      '</environment-instructions>',
    ].join('\n');

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: expectedInstructions,
      }),
    );
  });

  it('writes a generated shared-root AGENTS.md before startup without injecting a per-file AGENTS inventory into developer instructions', async () => {
    buildSandboxInstructionMock.mockReturnValue('Sandbox details' as never);

    await runTask({
      cloudJob: {
        id: 1522,
        taskId: 'task-1522',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      usesSharedWorkspaceRoot: true,
      repoPaths: {
        'Roomote/docs': '/tmp/workspace/Roomote/docs',
        'Roomote/example-app': '/tmp/workspace/Roomote/example-app',
      },
      prompt: '',
      harnessInstructions: 'Workflow instructions',
      agentInstructions: 'Run tests before finishing.',
      environmentConfig: {} as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    const sharedWorkspaceAgentsCall = writeFileSyncMock.mock.calls.find(
      ([targetPath]) => targetPath === '/tmp/workspace/AGENTS.md',
    );

    expect(sharedWorkspaceAgentsCall).toBeDefined();
    expect(sharedWorkspaceAgentsCall?.[1]).toContain(
      'Before investigation, planning, review, or edits in a repo path:',
    );
    expect(sharedWorkspaceAgentsCall?.[1]).toContain(
      "git -C <repo-dir> ls-files -- AGENTS.md '**/AGENTS.md'",
    );
    expect(sharedWorkspaceAgentsCall?.[1]).toContain(
      'Child repo `AGENTS.md` files may not have been auto-loaded.',
    );

    const developerInstructions =
      createHarnessMock.mock.calls.at(-1)?.[0]?.developerInstructionsContent;
    expect(developerInstructions).toBe(
      [
        'Workflow instructions',
        '',
        '<environment-instructions>',
        'Run tests before finishing.',
        'Sandbox details',
        '</environment-instructions>',
      ].join('\n'),
    );
    expect(developerInstructions).not.toContain(
      '/tmp/workspace/Roomote/example-app/AGENTS.md',
    );
    expect(developerInstructions).not.toContain(
      '/tmp/workspace/Roomote/docs/AGENTS.md',
    );
  });

  it('promotes wrapped explicit repo-local skill invocations based on the discovered workspace catalog', async () => {
    await runTask({
      cloudJob: {
        id: 1526,
        taskId: 'task-1526',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt:
        '<request>$docs-maintenance\n\n<task_context><target>docs</target></task_context></request>',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'docs-maintenance',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/docs-maintenance/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/docs-maintenance',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
      ],
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt:
        '$docs-maintenance\n<request>\n<task_context><target>docs</target></task_context>\n</request>',
      images: undefined,
      visibleInTranscript: false,
    });
  });

  it('promotes wrapped plain-text repo-local skill invocations when the first line matches the discovered catalog', async () => {
    await runTask({
      cloudJob: {
        id: 1527,
        taskId: 'task-1527',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt:
        '<request>prepare-release-candidate\n\n<context>release</context></request>',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
      ],
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt:
        'prepare-release-candidate\n<request>\n<context>release</context>\n</request>',
      images: undefined,
      visibleInTranscript: false,
    });
  });

  it('keeps bare repo-local skill promotion when mirrored roots exist only inside one repo', async () => {
    await runTask({
      cloudJob: {
        id: 1527,
        taskId: 'task-1527',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt:
        '<request>prepare-release-candidate\n\n<context>release</context></request>',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Roomote/.claude/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.claude/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Roomote/.claude/skills',
        },
      ],
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt:
        'prepare-release-candidate\n<request>\n<context>release</context>\n</request>',
      images: undefined,
      visibleInTranscript: false,
    });
  });

  it('does not promote an ambiguous bare repo-local skill name when multiple repos expose it', async () => {
    await runTask({
      cloudJob: {
        id: 1528,
        taskId: 'task-1528',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt:
        '<request>prepare-release-candidate\n\n<context>release</context></request>',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Docs',
          repoFullName: 'Roomote/docs',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Docs/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Docs/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Docs/.agents/skills',
        },
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
      ],
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt:
        '<request>prepare-release-candidate\n\n<context>release</context></request>',
      images: undefined,
      visibleInTranscript: false,
    });
  });

  it('promotes a repo-qualified repo-local skill invocation when the bare name is ambiguous', async () => {
    await runTask({
      cloudJob: {
        id: 1529,
        taskId: 'task-1529',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt:
        '<request>Roomote.prepare-release-candidate\n\n<context>release</context></request>',
      harnessInstructions: 'Workflow instructions',
      repoLocalSkills: [
        {
          repoName: 'Docs',
          repoFullName: 'Roomote/docs',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Docs/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Docs/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Docs/.agents/skills',
        },
        {
          repoName: 'Roomote',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate/SKILL.md',
          skillDirPath:
            '/tmp/workspace/Roomote/.agents/skills/prepare-release-candidate',
          skillRootPath: '/tmp/workspace/Roomote/.agents/skills',
        },
      ],
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(harnessManagerInstances.at(-1)?.startNewTask).toHaveBeenCalledWith({
      prompt:
        'Roomote.prepare-release-candidate\n<request>\n<context>release</context>\n</request>',
      images: undefined,
      visibleInTranscript: false,
    });
  });
  it('passes operator model config through the OpenCode runtime env', async () => {
    buildSandboxInstructionMock.mockReturnValue(undefined as never);

    await runTask({
      cloudJob: {
        id: 153,
        taskId: 'task-153',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {
        ROOMOTE_MODEL: 'provider-id/model-id',
        ROOMOTE_SMALL_MODEL: 'provider-id/small-model-id',
      },
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      environmentConfig: {
        initialUrl:
          'https://task-153-roomote-web.preview.roomote.run/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: undefined,
        runtimeEnv: expect.objectContaining({
          ROOMOTE_MODEL: 'provider-id/model-id',
          ROOMOTE_SMALL_MODEL: 'provider-id/small-model-id',
        }),
      }),
    );
  });

  it('passes launcher model config and provider keys through the OpenCode runtime env', async () => {
    buildSandboxInstructionMock.mockReturnValue(undefined as never);

    await runTask({
      cloudJob: {
        id: 155,
        taskId: 'task-155',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      environmentConfig: {
        initialUrl:
          'https://task-155-roomote-web.preview.roomote.run/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
        buildOpenCodeHarnessEnv: vi.fn(() => ({
          ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
          ROOMOTE_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
          ROOMOTE_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
          OPENROUTER_API_KEY: 'openrouter-key',
          CUSTOM_PROVIDER_API_KEY: 'custom-key',
          JOB_AUTH_PRIVATE_KEY: 'do-not-forward',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructionsContent: undefined,
        runtimeEnv: expect.objectContaining({
          ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
          ROOMOTE_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
          ROOMOTE_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
          OPENROUTER_API_KEY: 'openrouter-key',
          CUSTOM_PROVIDER_API_KEY: 'custom-key',
        }),
      }),
    );
    expect(
      createHarnessMock.mock.calls.at(-1)?.[0]?.runtimeEnv,
    ).not.toHaveProperty('JOB_AUTH_PRIVATE_KEY');
  });

  it('isolates the task runtime HOME while keeping packaged skill sourcing on the worker HOME', async () => {
    buildSandboxInstructionMock.mockReturnValue(undefined as never);

    await runTask({
      cloudJob: {
        id: 156,
        taskId: 'task-156',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      environmentConfig: {} as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(isOrgEnabledMock).toHaveBeenCalledWith('zero');
    expect(installZeroCliMock).not.toHaveBeenCalled();
    expect(activateSkillsFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeDir: '/tmp/workspace/.roomote-runtime-home',
        sourceHomeDir: '/tmp/home',
        excludeSkillNames: ['zero'],
      }),
    );
    expect(createHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: expect.objectContaining({
          HOME: '/tmp/workspace/.roomote-runtime-home',
        }),
      }),
    );
  });

  it('does not create child harness state for environment initial urls', async () => {
    buildSandboxInstructionMock.mockReturnValue(undefined as never);

    await runTask({
      cloudJob: {
        id: 154,
        taskId: 'task-154',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: {
        initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      } as never,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    expect(createHarnessMock).toHaveBeenCalledWith(expect.objectContaining({}));
  });

  it('serializes runtime-state updates so phase transitions persist in emission order', async () => {
    let resolveFirstRuntimeUpdate: (() => void) | null = null;
    const firstRuntimeUpdate = new Promise<{ updated: boolean }>((resolve) => {
      resolveFirstRuntimeUpdate = () => resolve({ updated: true });
    });
    const subprocessDeferred = new Promise<void>(() => {});

    awaitSubprocessMock.mockReturnValue(subprocessDeferred);
    cloudJobsUpdateRuntimeStateMock.mockImplementation(
      (values: { taskPhase?: string }) => {
        if (!values.taskPhase) {
          return Promise.resolve({ updated: false });
        }

        if (values.taskPhase === 'waiting_for_prompt') {
          return firstRuntimeUpdate;
        }

        return Promise.resolve({ updated: true });
      },
    );

    void runTask({
      cloudJob: {
        id: 103,
        taskId: 'task-103',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager).toBeDefined();

    harnessManager!.currentSleepAt = 1_000;
    harnessManager!.emit('stateChange', 'waiting_for_prompt', {
      sessionId: 'session-1',
      cancelTriggeredAt: undefined,
      lastMessageAt: undefined,
      taskFinishedAt: undefined,
      taskAbortedAt: undefined,
    });

    harnessManager!.currentSleepAt = 2_000;
    harnessManager!.emit('stateChange', 'running', {
      sessionId: 'session-1',
      cancelTriggeredAt: undefined,
      lastMessageAt: Date.now(),
      taskFinishedAt: undefined,
      taskAbortedAt: undefined,
    });

    await new Promise((resolve) => setImmediate(resolve));

    let runtimePhaseCalls = cloudJobsUpdateRuntimeStateMock.mock.calls
      .map(([arg]) => arg as { taskPhase?: string })
      .filter((arg) => arg.taskPhase);

    expect(runtimePhaseCalls).toHaveLength(1);
    expect(runtimePhaseCalls[0]?.taskPhase).toBe('waiting_for_prompt');

    expect(resolveFirstRuntimeUpdate).toBeTypeOf('function');
    resolveFirstRuntimeUpdate!();

    await new Promise((resolve) => setImmediate(resolve));

    runtimePhaseCalls = cloudJobsUpdateRuntimeStateMock.mock.calls
      .map(([arg]) => arg as { taskPhase?: string })
      .filter((arg) => arg.taskPhase);

    expect(runtimePhaseCalls).toHaveLength(2);
    expect(runtimePhaseCalls[1]?.taskPhase).toBe('running');
  });

  it('does not block later runtime-state writes on worker event inserts', async () => {
    let resolveFirstRuntimeUpdate: (() => void) | null = null;
    const firstRuntimeUpdate = new Promise<{ updated: boolean }>((resolve) => {
      resolveFirstRuntimeUpdate = () => resolve({ updated: true });
    });
    let resolveFirstPersistedStateEvent: (() => void) | null = null;
    const firstPersistedStateEvent = new Promise<void>((resolve) => {
      resolveFirstPersistedStateEvent = resolve;
    });
    let persistedStateEventCount = 0;
    const subprocessDeferred = new Promise<void>(() => {});

    awaitSubprocessMock.mockReturnValue(subprocessDeferred);
    cloudJobsUpdateRuntimeStateMock.mockImplementation(
      (values: { taskPhase?: string }) => {
        if (!values.taskPhase) {
          return Promise.resolve({ updated: false });
        }

        if (values.taskPhase === 'waiting_for_prompt') {
          return firstRuntimeUpdate;
        }

        return Promise.resolve({ updated: true });
      },
    );
    cloudJobsRecordEventMock.mockImplementation(
      (values: { message?: string }) => {
        if (values.message === 'Persisted runtime state for cloud job #105.') {
          persistedStateEventCount += 1;

          if (persistedStateEventCount === 1) {
            return firstPersistedStateEvent;
          }
        }

        return Promise.resolve(undefined);
      },
    );

    void runTask({
      cloudJob: {
        id: 105,
        taskId: 'task-105',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager).toBeDefined();

    harnessManager!.currentSleepAt = 1_000;
    harnessManager!.emit('stateChange', 'waiting_for_prompt', {
      sessionId: 'session-1',
      cancelTriggeredAt: undefined,
      lastMessageAt: undefined,
      taskFinishedAt: undefined,
      taskAbortedAt: undefined,
    });

    harnessManager!.currentSleepAt = 2_000;
    harnessManager!.emit('stateChange', 'running', {
      sessionId: 'session-1',
      cancelTriggeredAt: undefined,
      lastMessageAt: Date.now(),
      taskFinishedAt: undefined,
      taskAbortedAt: undefined,
    });

    await new Promise((resolve) => setImmediate(resolve));

    let runtimePhaseCalls = cloudJobsUpdateRuntimeStateMock.mock.calls
      .map(([arg]) => arg as { taskPhase?: string })
      .filter((arg) => arg.taskPhase);

    expect(runtimePhaseCalls).toHaveLength(1);
    expect(runtimePhaseCalls[0]?.taskPhase).toBe('waiting_for_prompt');

    expect(resolveFirstRuntimeUpdate).toBeTypeOf('function');
    resolveFirstRuntimeUpdate!();

    await new Promise((resolve) => setImmediate(resolve));

    runtimePhaseCalls = cloudJobsUpdateRuntimeStateMock.mock.calls
      .map(([arg]) => arg as { taskPhase?: string })
      .filter((arg) => arg.taskPhase);

    expect(runtimePhaseCalls).toHaveLength(2);
    expect(runtimePhaseCalls[1]?.taskPhase).toBe('running');

    expect(resolveFirstPersistedStateEvent).toBeTypeOf('function');
    resolveFirstPersistedStateEvent!();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('waits for queued runtime-state writes before marking the job idle', async () => {
    let resolveRuntimeUpdate: (() => void) | null = null;
    const pendingRuntimeUpdate = new Promise<{ updated: boolean }>(
      (resolve) => {
        resolveRuntimeUpdate = () => resolve({ updated: true });
      },
    );
    const subprocessDeferred = new Promise<void>(() => {});

    awaitSubprocessMock.mockReturnValue(subprocessDeferred);
    cloudJobsUpdateRuntimeStateMock.mockImplementation(
      (values: { taskPhase?: string }) => {
        if (values.taskPhase === 'waiting_for_prompt') {
          return pendingRuntimeUpdate;
        }

        return Promise.resolve({ updated: true });
      },
    );

    void runTask({
      cloudJob: {
        id: 104,
        taskId: 'task-104',
        type: CloudTaskType.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
      envVars: {},
      workspacePath: '/tmp/workspace',
      prompt: '',
      harnessInstructions: undefined,
      agentInstructions: undefined,
      environmentConfig: undefined,
      callbacks: {},
      context: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as never,
      harnessSessionId: undefined,
      workerEnv: {
        authToken: 'cloud-token',
        roomoteAppUrl: 'https://api.example.test',
        trpcUrl: 'https://web.example.test',
        buildUserFacingEnv: vi.fn(() => ({
          HOME: '/tmp/home',
          PATH: '/usr/bin',
        })),
      } as never,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const harnessManager = harnessManagerInstances.at(0);
    expect(harnessManager).toBeDefined();

    harnessManager!.currentSleepAt = 5_000;
    harnessManager!.emit('stateChange', 'waiting_for_prompt', {
      sessionId: 'session-1',
      cancelTriggeredAt: undefined,
      lastMessageAt: Date.now(),
      taskFinishedAt: Date.now(),
      taskAbortedAt: undefined,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const onExitPromise = harnessManager!.callbacks?.onExit?.();

    await new Promise((resolve) => setImmediate(resolve));

    expect(cloudJobsDoneMock).not.toHaveBeenCalled();

    expect(resolveRuntimeUpdate).toBeTypeOf('function');
    resolveRuntimeUpdate!();
    await onExitPromise;

    expect(cloudJobsDoneMock).toHaveBeenCalledWith({
      id: 104,
      status: CloudTaskStatus.Idle,
    });
  });

  describe('worker crash handlers', () => {
    const buildCrashTestOptions = (id: number) =>
      ({
        cloudJob: {
          id,
          taskId: `task-${id}`,
          type: CloudTaskType.StandardTask,
          harness: 'opencode-server',
          payload: {},
          result: null,
        },
        envVars: {},
        workspacePath: '/tmp/workspace',
        prompt: '',
        harnessInstructions: undefined,
        orgAgentInstructions: undefined,
        styleGuidance: undefined,
        agentInstructions: undefined,
        environmentConfig: undefined,
        callbacks: {},
        context: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        },
        harnessSessionId: undefined,
        workerEnv: {
          authToken: 'cloud-token',
          roomoteAppUrl: 'https://api.example.test',
          trpcUrl: 'https://web.example.test',
          buildUserFacingEnv: vi.fn(() => ({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
          })),
        },
      }) as never;

    beforeEach(() => {
      // Earlier tests in this file set a never-resolving subprocess promise via
      // `mockReturnValue`, which `vi.clearAllMocks()` does not undo; reset it so
      // runTask can finish and we can observe post-run crash-handler state.
      awaitSubprocessMock.mockReset();
      awaitSubprocessMock.mockResolvedValue(undefined);
    });

    it('does not leak crash listeners across repeated runTask invocations', async () => {
      const uncaughtBefore = process.listenerCount('uncaughtException');
      const unhandledBefore = process.listenerCount('unhandledRejection');

      await runTask(buildCrashTestOptions(7100));
      const uncaughtAfterFirst = process.listenerCount('uncaughtException');
      const unhandledAfterFirst = process.listenerCount('unhandledRejection');

      await runTask(buildCrashTestOptions(7101));
      const uncaughtAfterSecond = process.listenerCount('uncaughtException');
      const unhandledAfterSecond = process.listenerCount('unhandledRejection');

      // The module-level handlers register at most once per process, so the
      // count must not grow with each run (regression for finding F: leaked,
      // stacking listeners across executeJob retries).
      expect(uncaughtAfterSecond).toBe(uncaughtAfterFirst);
      expect(unhandledAfterSecond).toBe(unhandledAfterFirst);
      expect(uncaughtAfterFirst).toBeLessThanOrEqual(uncaughtBefore + 1);
      expect(unhandledAfterFirst).toBeLessThanOrEqual(unhandledBefore + 1);
    });

    it('clears the active crash context after a completed run (no crash write)', async () => {
      await runTask(buildCrashTestOptions(7102));

      // A normal completed run never persists a workerCrash result, and the
      // try/finally clears the active context so no later crash can be
      // attributed to this finished job.
      const crashWrites = cloudJobsUpdateMock.mock.calls.filter(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].result &&
          typeof call[0].result === 'object' &&
          'workerCrash' in call[0].result,
      );
      expect(crashWrites).toHaveLength(0);
    });

    it('clears the crash context even when runTask throws and does not leak listeners', async () => {
      const uncaughtBefore = process.listenerCount('uncaughtException');

      waitForShutdownMock.mockRejectedValueOnce(new Error('boom in shutdown'));

      await expect(runTask(buildCrashTestOptions(7103))).rejects.toThrow(
        'boom in shutdown',
      );

      // The finally block must run on the throw path, so the listener count is
      // unchanged and a subsequent run still does not stack listeners.
      expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore);

      await runTask(buildCrashTestOptions(7104));
      expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore);
    });
  });
});
