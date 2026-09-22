import type { RunTokenContext } from '@roomote/types';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function createCaller(harness: Record<string, unknown>) {
  const ctx = {
    workingDirectory: '/tmp/workspace',
    harness,
    auth: {
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId: 1,
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('checkCompletionBeforeTool', () => {
  it('hands the tool call to the harness and returns its decision', async () => {
    const checkCompletionBeforeTool = vi.fn(async () => ({
      allowed: false,
      reason: 'Roomote held this report.',
    }));
    const caller = createCaller({
      isConnected: true,
      checkCompletionBeforeTool,
    });

    await expect(
      caller.commands.checkCompletionBeforeTool({
        tool: 'roomote_send_chat_reply',
        args: { message: 'Done.' },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'Roomote held this report.' });
    expect(checkCompletionBeforeTool).toHaveBeenCalledWith({
      tool: 'roomote_send_chat_reply',
      args: { message: 'Done.' },
    });
  });

  it('allows every call for a harness without the check', async () => {
    const caller = createCaller({ isConnected: true });

    await expect(
      caller.commands.checkCompletionBeforeTool({ tool: 'bash', args: {} }),
    ).resolves.toEqual({ allowed: true });
  });
});
