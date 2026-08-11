import EventEmitter from 'node:events';

import type { TaskCommand } from '../../lib/harness';
import { HarnessManager } from '../../lib/harness-manager';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';
import { ReconnectableHarness } from '../../../run-task/reconnectable-harness';

function createLogger() {
  return {
    runId: 1,
    filePath: '/tmp/test.log',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
}

describe('switchModel procedure', () => {
  it('switches through a reconnectable harness using its forwarded model state', async () => {
    const sentCommands: TaskCommand[] = [];
    const harness = new (class extends EventEmitter {
      get isConnected() {
        return true;
      }

      get supportsNativeTurnSteering() {
        return false;
      }

      getActiveModel() {
        return 'provider/launch';
      }

      getLaunchModel() {
        return 'provider/launch';
      }

      getSwitchableModels() {
        return ['provider/launch', 'provider/next'];
      }

      getPendingUserInputRequests() {
        return [];
      }

      getQueuedMessageSnapshots() {
        return [];
      }

      sendCommand(command: TaskCommand) {
        sentCommands.push(command);
        return true;
      }

      dispose() {}
    })();
    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness: harness as never,
        subprocess: Object.assign(new Promise<never>(() => undefined), {
          kill: vi.fn(() => true),
        }) as never,
      }),
    });
    await reconnectableHarness.start();

    const harnessManager = new HarnessManager({
      harness: reconnectableHarness,
      keepaliveMs: 1_000,
      logger: createLogger(),
    });
    const caller = appRouter.createCaller({
      workingDirectory: '/tmp',
      harness: reconnectableHarness,
      harnessManager,
    } as unknown as Context);

    try {
      await expect(
        caller.commands.switchModel({ model: 'provider/next' }),
      ).resolves.toEqual({
        success: true,
        activeModel: 'provider/next',
        changed: true,
      });
      expect(sentCommands).toContainEqual({
        commandName: 'SwitchModel',
        data: { model: 'provider/next', reason: 'user' },
      });
    } finally {
      harnessManager.dispose();
      reconnectableHarness.dispose();
    }
  });
});
