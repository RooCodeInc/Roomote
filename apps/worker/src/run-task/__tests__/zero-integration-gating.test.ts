import { EventEmitter } from 'node:events';

const {
  activateSkillsFolderMock,
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
  startPollingMock,
  stopPollingMock,
  waitForShutdownMock,
  waitForExternalSleepActionMock,
  mkdirSyncMock,
  writeFileSyncMock,
  installZeroCliMock,
  taskRunsDoneMock,
  taskRunsStampMilestoneMock,
  taskRunsSyncActingUserIdMock,
  taskRunsSetHarnessSessionIdMock,
  taskRunsUpdateRuntimeStateMock,
  taskRunsUpdateMock,
  taskRunsRecordEventMock,
  syncRuntimeGitAuthorMock,
  buildSandboxInstructionMock,
  awaitSubprocessMock,
} = vi.hoisted(() => ({
  activateSkillsFolderMock: vi.fn(() => false),
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
  existsSyncMock: vi.fn(() => false),
  getDecryptedKeyMock: vi.fn().mockResolvedValue(undefined),
  getMcpServerConfigsMock: vi.fn().mockResolvedValue({ servers: {} }),
  harnessManagerInstances: [] as Array<EventEmitter>,
  hasActiveInstallationMock: vi.fn().mockResolvedValue(false),
  isOrgEnabledMock: vi.fn().mockResolvedValue(false),
  mockEvaluateFeatureFlag: vi.fn().mockResolvedValue(false),
  resolvePackagedSkillsFolderMock: vi.fn(() => 'standard'),
  resolveStatusMock: vi.fn(() => ({ status: 'idle' })),
  startPollingMock: vi.fn(),
  stopPollingMock: vi.fn(),
  waitForShutdownMock: vi.fn().mockResolvedValue({
    sessionId: undefined,
    cancelTriggeredAt: undefined,
    lastMessageAt: undefined,
    taskFinishedAt: Date.now(),
    taskAbortedAt: undefined,
  }),
  waitForExternalSleepActionMock: vi
    .fn()
    .mockResolvedValue({ claimed: false, completed: false }),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  installZeroCliMock: vi.fn().mockResolvedValue(undefined),
  taskRunsDoneMock: vi.fn().mockResolvedValue(undefined),
  taskRunsStampMilestoneMock: vi.fn().mockResolvedValue(undefined),
  taskRunsSyncActingUserIdMock: vi.fn().mockResolvedValue({
    result: 'unchanged',
    actingUserId: 'user-1',
  }),
  taskRunsSetHarnessSessionIdMock: vi.fn().mockResolvedValue(undefined),
  taskRunsUpdateRuntimeStateMock: vi.fn().mockResolvedValue({ updated: true }),
  taskRunsUpdateMock: vi.fn().mockResolvedValue(undefined),
  taskRunsRecordEventMock: vi.fn().mockResolvedValue(undefined),
  syncRuntimeGitAuthorMock: vi.fn().mockResolvedValue(undefined),
  buildSandboxInstructionMock: vi.fn(() => undefined),
  awaitSubprocessMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

vi.mock('@roomote/cloud-agents', () => ({
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS: ['implement-changes'],
  ROOMOTE_COMPACT_PROMPT: 'Default compaction prompt.',
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      done: taskRunsDoneMock,
      recordEvent: taskRunsRecordEventMock,
      stampMilestone: taskRunsStampMilestoneMock,
      setHarnessSessionId: taskRunsSetHarnessSessionIdMock,
      syncActingUserId: taskRunsSyncActingUserIdMock,
      update: taskRunsUpdateMock,
      updateRuntimeState: taskRunsUpdateRuntimeStateMock,
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
    constructor() {
      super();
      harnessManagerInstances.push(this);
    }
    waitForShutdown() {
      return waitForShutdownMock();
    }
  },
  createInitialTaskState: createInitialTaskStateMock,
  createServer: createServerMock,
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
  seedRuntimeHomeMiseGlobalConfig: vi.fn(() => false),
}));

vi.mock('../create-harness', () => ({
  createHarness: createHarnessMock,
}));

vi.mock('../sandbox-instruction', () => ({
  buildSandboxInstruction: buildSandboxInstructionMock,
}));

vi.mock('../subprocess', () => ({
  awaitSubprocess: awaitSubprocessMock,
}));

vi.mock('../resolve-status', () => ({
  resolveStatus: resolveStatusMock,
}));

vi.mock('../polling', () => ({
  startPolling: startPollingMock,
  stopPolling: stopPollingMock,
}));

vi.mock('../wait-for-external-sleep-action', () => ({
  waitForExternalSleepAction: waitForExternalSleepActionMock,
}));

vi.mock('../../lib/sync-runtime-git-author', () => ({
  syncRuntimeGitAuthor: syncRuntimeGitAuthorMock,
}));

import { TaskPayloadKind } from '@roomote/types';

import { runTask } from '../run-task';

function baseRunTaskArgs() {
  return {
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
  };
}

describe('Zero integration runtime gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harnessManagerInstances.length = 0;
    existsSyncMock.mockReturnValue(false);
    isOrgEnabledMock.mockResolvedValue(false);
    getMcpServerConfigsMock.mockResolvedValue({ servers: {} });
    resolvePackagedSkillsFolderMock.mockReturnValue('standard');
    createHarnessMock.mockResolvedValue({
      harness: {},
      getSubprocess: vi.fn(() => ({})),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    });
    waitForShutdownMock.mockResolvedValue({
      sessionId: undefined,
      cancelTriggeredAt: undefined,
      lastMessageAt: undefined,
      taskFinishedAt: Date.now(),
      taskAbortedAt: undefined,
    });
  });

  it('excludes the zero skill and skips CLI install when Zero is not org-enabled', async () => {
    await runTask({
      ...baseRunTaskArgs(),
      taskRun: {
        id: 201,
        taskId: 'task-zero-disabled',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
    });

    expect(isOrgEnabledMock).toHaveBeenCalledWith('zero');
    expect(installZeroCliMock).not.toHaveBeenCalled();
    expect(activateSkillsFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeSkillNames: ['zero'],
      }),
    );
  });

  it('installs the Zero CLI and activates the zero skill when Zero is org-enabled', async () => {
    isOrgEnabledMock.mockResolvedValueOnce(true);

    await runTask({
      ...baseRunTaskArgs(),
      taskRun: {
        id: 202,
        taskId: 'task-zero-enabled',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {},
        result: null,
      } as never,
    });

    expect(isOrgEnabledMock).toHaveBeenCalledWith('zero');
    expect(installZeroCliMock).toHaveBeenCalledTimes(1);
    expect(activateSkillsFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeSkillNames: undefined,
      }),
    );
  });
});
