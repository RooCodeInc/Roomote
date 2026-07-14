const { sdkTaskRunsUpdateEnvironmentSetupMock } = vi.hoisted(() => ({
  sdkTaskRunsUpdateEnvironmentSetupMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      updateEnvironmentSetup: sdkTaskRunsUpdateEnvironmentSetupMock,
    },
  },
}));

import type { TaskRun } from '@roomote/sdk/client';

import type { EnvironmentSetupWarning } from '../setup/workspace/types';

import { BackgroundEnvironmentSetupController } from './background-environment-setup-controller';

const taskRun = { id: 42 } as TaskRun;

describe('BackgroundEnvironmentSetupController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports no pending setup without a background promise and never fires listeners', async () => {
    const listener = vi.fn();
    const controller = new BackgroundEnvironmentSetupController({
      taskRun,
      recordWorkerRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    });

    expect(controller.hasPendingBackgroundSetup).toBe(false);
    controller.onSettled(listener);
    await controller.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(sdkTaskRunsUpdateEnvironmentSetupMock).not.toHaveBeenCalled();
  });

  it('notifies listeners and persists the terminal state when setup settles mid-task', async () => {
    let resolveSetup: (warnings: EnvironmentSetupWarning[]) => void;
    const backgroundSetupPromise = new Promise<EnvironmentSetupWarning[]>(
      (resolve) => {
        resolveSetup = resolve;
      },
    );
    const recordWorkerRuntimeEvent = vi.fn().mockResolvedValue(undefined);
    const controller = new BackgroundEnvironmentSetupController({
      taskRun,
      backgroundSetupPromise,
      recordWorkerRuntimeEvent,
    });

    const listener = vi.fn();
    controller.onSettled(listener);

    expect(controller.hasPendingBackgroundSetup).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    resolveSetup!([{ message: 'Optional command "install" failed' }]);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });

    expect(listener).toHaveBeenCalledWith({
      status: 'fulfilled',
      warningMessages: ['Optional command "install" failed'],
    });
    expect(controller.hasPendingBackgroundSetup).toBe(false);

    await vi.waitFor(() => {
      expect(sdkTaskRunsUpdateEnvironmentSetupMock).toHaveBeenCalledWith({
        runId: 42,
        state: 'completed_with_warnings',
        completedAt: expect.any(Date),
      });
    });

    await controller.flush();
    expect(recordWorkerRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'decision',
        details: expect.objectContaining({
          reason: 'background_environment_setup_warning',
        }),
      }),
    );
  });

  it('persists completed (no warnings) without recording a warning event', async () => {
    const controller = new BackgroundEnvironmentSetupController({
      taskRun,
      backgroundSetupPromise: Promise.resolve([]),
      recordWorkerRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    });

    const listener = vi.fn();
    controller.onSettled(listener);
    await controller.flush();

    expect(listener).toHaveBeenCalledWith({
      status: 'fulfilled',
      warningMessages: [],
    });
    expect(sdkTaskRunsUpdateEnvironmentSetupMock).toHaveBeenCalledWith({
      runId: 42,
      state: 'completed',
      completedAt: expect.any(Date),
    });
  });

  it('fires a late-registered listener immediately when setup already settled', async () => {
    const controller = new BackgroundEnvironmentSetupController({
      taskRun,
      backgroundSetupPromise: Promise.resolve([]),
      recordWorkerRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    });

    await controller.flush();

    const listener = vi.fn();
    controller.onSettled(listener);

    expect(listener).toHaveBeenCalledWith({
      status: 'fulfilled',
      warningMessages: [],
    });
  });

  it('persists failed and delivers a rejected outcome when setup throws', async () => {
    const controller = new BackgroundEnvironmentSetupController({
      taskRun,
      backgroundSetupPromise: Promise.reject(new Error('setup exploded')),
      recordWorkerRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    });

    const listener = vi.fn();
    controller.onSettled(listener);

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith({
        status: 'rejected',
        errorMessage: 'setup exploded',
      });
    });

    await vi.waitFor(() => {
      expect(sdkTaskRunsUpdateEnvironmentSetupMock).toHaveBeenCalledWith({
        runId: 42,
        state: 'failed',
        completedAt: expect.any(Date),
      });
    });

    await expect(controller.flush()).rejects.toThrow('setup exploded');
  });
});
