import { z } from 'zod';

import { publicProcedure } from '../trpc';

const inputSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.unknown().optional(),
});

/**
 * Called by the sandbox's OpenCode plugin before a tool call that reports to
 * a person or ships the work. The harness decides whether the call goes
 * through; a denial carries the reasons the agent should read.
 */
export const checkCompletionBeforeTool = publicProcedure
  .input(inputSchema)
  .mutation(async ({ ctx, input }) => {
    if (!ctx.harness.checkCompletionBeforeTool) {
      return { allowed: true as const };
    }

    return ctx.harness.checkCompletionBeforeTool(input);
  });
