import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { listMcpOAuthGrants, revokeMcpOAuthGrants } from '@roomote/redis';

import { createRouter, protectedProcedure } from '../init';

const target = z
  .object({ userId: z.string().min(1).max(256).optional() })
  .strict();
function authorizedTarget(
  auth: { userId: string; isAdmin: boolean },
  userId?: string,
) {
  if (userId && userId !== auth.userId && !auth.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only admins can manage another user’s MCP clients',
    });
  }
  return userId ?? auth.userId;
}

export const mcpAuthorizationsRouter = createRouter({
  list: protectedProcedure
    .input(target)
    .query(({ ctx: { auth }, input }) =>
      listMcpOAuthGrants(authorizedTarget(auth, input.userId)),
    ),
  revoke: protectedProcedure
    .input(target.extend({ grantId: z.string().regex(/^[a-f0-9]{64}$/) }))
    .mutation(async ({ ctx: { auth }, input }) => {
      await revokeMcpOAuthGrants(
        authorizedTarget(auth, input.userId),
        input.grantId,
      );
      return { success: true };
    }),
  revokeAll: protectedProcedure
    .input(target)
    .mutation(async ({ ctx: { auth }, input }) => {
      await revokeMcpOAuthGrants(authorizedTarget(auth, input.userId));
      return { success: true };
    }),
});
