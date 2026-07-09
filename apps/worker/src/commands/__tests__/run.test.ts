const { executeJobMock, runTaskMock } = vi.hoisted(() => ({
  executeJobMock: vi.fn(),
  runTaskMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {},
  },
}));

vi.mock('../../run-task', () => ({
  runTask: runTaskMock,
}));

vi.mock('../utils', () => ({
  buildWorkspaceConfig: vi.fn(),
  executeJob: executeJobMock,
}));

import { TaskPayloadKind } from '@roomote/types';

import { run } from '../run';

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTaskMock.mockResolvedValue(undefined);
  });

  it('keeps sandbox-backed task execution for non-eval cloud jobs', async () => {
    executeJobMock.mockResolvedValue(true);

    const result = await run({ cloudJobId: 99, setupMode: 'full' });

    expect(result).toBe(true);
    expect(executeJobMock).toHaveBeenCalledOnce();
  });

  it('passes direct-run setup options through to task execution', async () => {
    executeJobMock.mockResolvedValue(true);

    const result = await run({
      cloudJobId: 99,
      setupMode: 'directDispatch',
      preserveGitState: true,
      keepaliveMsOverride: 30_000,
    });

    expect(result).toBe(true);
    expect(executeJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 99,
        setupMode: 'directDispatch',
        preserveGitState: true,
      }),
    );
  });

  it('forwards direct-run keepalive overrides into runTask', async () => {
    executeJobMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          cloudJob: {
            id: 99,
            payloadKind: TaskPayloadKind.StandardTask,
          },
          envVars: {},
          prompt: 'keep this local task open',
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
        },
        workspace: {
          environmentConfig: {
            agentInstructions: undefined,
          },
        },
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        callbacks: {},
        context: {},
        logger: {} as never,
        workerEnv: {} as never,
      });

      return true;
    });

    await run({
      cloudJobId: 99,
      setupMode: 'directDispatch',
      keepaliveMsOverride: 30_000,
    });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        keepaliveMsOverride: 30_000,
        skipExternalSleepAction: true,
      }),
    );
  });

  it('forwards native proof capture into runTask', async () => {
    executeJobMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          cloudJob: {
            id: 99,
            payloadKind: TaskPayloadKind.StandardTask,
          },
          envVars: {},
          prompt: 'proof me',
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
        },
        workspace: {
          environmentConfig: {
            agentInstructions: 'env agent instructions',
          },
        },
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        callbacks: {},
        context: {},
        logger: {} as never,
        workerEnv: {} as never,
      });

      return true;
    });

    await run({ cloudJobId: 99, setupMode: 'full' });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'proof me',
      }),
    );
  });

  it('forwards workspace readiness warnings into runTask', async () => {
    executeJobMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          cloudJob: {
            id: 100,
            payloadKind: TaskPayloadKind.StandardTask,
            taskId: 'task-100',
          },
          envVars: {},
          prompt: 'inspect the repo',
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
        },
        workspace: {
          environmentConfig: {
            agentInstructions: 'env agent instructions',
          },
        },
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        workspaceReadinessWarnings: [
          'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
        ],
        callbacks: {},
        context: {},
        logger: {} as never,
        workerEnv: {} as never,
      });

      return true;
    });

    await run({ cloudJobId: 100, setupMode: 'full' });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceReadinessWarnings: [
          'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
        ],
      }),
    );
  });
});
