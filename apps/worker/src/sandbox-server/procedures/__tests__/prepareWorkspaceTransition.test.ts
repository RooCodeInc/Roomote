import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function context(
  phase: 'idle' | 'running',
  workspaceTransitionState: NonNullable<Context['workspaceTransitionState']> = {
    requested: false,
  },
): Context {
  return {
    workingDirectory: '/workspace',
    auth: null,
    harness: {} as Context['harness'],
    harnessManager: {
      getStatus: () => ({ phase }),
    } as Context['harnessManager'],
    workspaceTransitionState,
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
    expect(ctx.workspaceTransitionState?.requested).toBe(true);

    const nextRequestContext = context('idle', ctx.workspaceTransitionState);
    await appRouter
      .createCaller(nextRequestContext)
      .commands.abortWorkspaceTransition();
    expect(ctx.workspaceTransitionState?.requested).toBe(false);
  });

  it('does not leave a fence when an agent turn is active', async () => {
    const ctx = context('running');
    const result = await appRouter
      .createCaller(ctx)
      .commands.prepareWorkspaceTransition();

    expect(result).toEqual({ ready: false, phase: 'running' });
    expect(ctx.workspaceTransitionState?.requested).toBe(false);
  });
});
