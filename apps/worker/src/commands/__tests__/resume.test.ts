const { executeTaskRunMock, resumeMock, runTaskMock } = vi.hoisted(() => ({
  executeTaskRunMock: vi.fn(),
  resumeMock: vi.fn(),
  runTaskMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      resume: resumeMock,
    },
  },
}));

vi.mock('../../run-task', () => ({
  runTask: runTaskMock,
}));

vi.mock('../callbacks/linear-agent', () => ({
  linearAgentCallbacks: { onStart: vi.fn() },
}));

vi.mock('../callbacks/slack-mention', () => ({
  slackMentionCallbacks: { onStart: vi.fn() },
}));

vi.mock('../utils', () => ({
  buildWorkspaceConfig: vi.fn(),
  executeTaskRun: executeTaskRunMock,
}));

import { TaskPayloadKind } from '@roomote/types';

import { resume } from '../resume';

describe('resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTaskMock.mockResolvedValue(undefined);
  });

  it('forwards native proof capture into runTask', async () => {
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
            id: 42,
            payloadKind: TaskPayloadKind.StandardTask,
            taskId: 'task-42',
          },
          envVars: {},
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
          harnessSessionId: 'session-42',
        },
        workspace: {
          environmentConfig: {
            agentInstructions: 'resume agent instructions',
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

    await resume(42);

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessSessionId: 'session-42',
      }),
    );
  });

  it('forwards workspace readiness warnings into runTask', async () => {
    executeTaskRunMock.mockImplementation(async ({ runFn }) => {
      await runFn({
        jobContext: {
          taskRun: {
            id: 43,
            payloadKind: TaskPayloadKind.StandardTask,
            taskId: 'task-43',
          },
          envVars: {},
          harnessInstructions: undefined,
          orgAgentInstructions: undefined,
          styleGuidance: undefined,
          harnessSessionId: 'session-43',
        },
        workspace: {
          environmentConfig: {
            agentInstructions: 'resume agent instructions',
          },
        },
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        workspaceReadinessWarnings: [
          'Environment services failed to start: postgres failed to become healthy',
        ],
        callbacks: {},
        context: {},
        logger: {} as never,
        workerEnv: {} as never,
      });

      return true;
    });

    await resume(43);

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceReadinessWarnings: [
          'Environment services failed to start: postgres failed to become healthy',
        ],
      }),
    );
  });
});
