import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function context(phase: 'idle' | 'running'): Context {
  return {
    workingDirectory: '/workspace',
    auth: null,
    harness: {} as Context['harness'],
    harnessManager: {
      getStatus: () => ({ phase }),
    } as Context['harnessManager'],
  };
}

describe('prepareWorkspaceTransition', () => {
  it('fences delivery for an idle task and can release the fence', async () => {
    const ctx = context('idle');
    const caller = appRouter.createCaller(ctx);

    await expect(caller.commands.prepareWorkspaceTransition()).resolves.toEqual(
      {
        ready: true,
        phase: 'idle',
      },
    );
    expect(ctx.workspaceTransitionRequested).toBe(true);

    await caller.commands.abortWorkspaceTransition();
    expect(ctx.workspaceTransitionRequested).toBe(false);
  });

  it('does not leave a fence when an agent turn is active', async () => {
    const ctx = context('running');
    const result = await appRouter
      .createCaller(ctx)
      .commands.prepareWorkspaceTransition();

    expect(result).toEqual({ ready: false, phase: 'running' });
    expect(ctx.workspaceTransitionRequested).toBe(false);
  });
});
