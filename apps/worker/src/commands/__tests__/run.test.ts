const { executeTaskRunMock, runTaskMock } = vi.hoisted(() => ({
  executeTaskRunMock: vi.fn(),
  runTaskMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {},
  },
}));

vi.mock('../../run-task', () => ({
  runTask: runTaskMock,
}));

vi.mock('../utils', () => ({
  buildWorkspaceConfig: vi.fn(),
  executeTaskRun: executeTaskRunMock,
}));

import { TaskPayloadKind } from '@roomote/types';

import { run } from '../run';

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTaskMock.mockResolvedValue(undefined);
  });

  it('keeps sandbox-backed task execution for non-eval task runs', async () => {
    executeTaskRunMock.mockResolvedValue(true);

    const result = await run({ runId: 99, setupMode: 'full' });

    expect(result).toBe(true);
    expect(executeTaskRunMock).toHaveBeenCalledOnce();
  });

  it('passes direct-run setup options through to task execution', async () => {
    executeTaskRunMock.mockResolvedValue(true);

    const result = await run({
      runId: 99,
      setupMode: 'directDispatch',
      preserveGitState: true,
      keepaliveMsOverride: 30_000,
    });

    expect(result).toBe(true);
    expect(executeTaskRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 99,
        setupMode: 'directDispatch',
        preserveGitState: true,
      }),
    );
  });

  it('forwards direct-run keepalive overrides into runTask', async () => {
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
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
      runId: 99,
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
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
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

    await run({ runId: 99, setupMode: 'full' });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'proof me',
      }),
    );
  });

  it('forwards the dequeue response requestedWorkKind and task bindings into runTask', async () => {
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
            id: 101,
            payloadKind: TaskPayloadKind.StandardTask,
            taskId: 'task-101',
          },
          envVars: {},
          prompt: 'fix the bug',
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
          requestedWorkKind: 'unknown',
          task: {
            id: 'task-101',
            slackChannelId: 'C123',
            slackThreadTs: '111.222',
            linearSessionId: null,
          },
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

    await run({ runId: 101, setupMode: 'full' });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedWorkKind: 'unknown',
        task: expect.objectContaining({
          slackChannelId: 'C123',
          slackThreadTs: '111.222',
          linearSessionId: null,
        }),
      }),
    );
  });

  it('forwards workspace readiness warnings into runTask', async () => {
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
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

    await run({ runId: 100, setupMode: 'full' });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceReadinessWarnings: [
          'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
        ],
      }),
    );
  });
});
