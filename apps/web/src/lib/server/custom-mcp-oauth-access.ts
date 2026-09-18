import {
  canManageCustomMcpServer,
  type CustomMcpAuthTarget,
} from '@roomote/sdk/server';

/**
 * Whether the signed-in member may run the OAuth flow for a custom server's
 * connection. The connection has to be the one that belongs to the server
 * (the owner's row for a personal server, the deployment row otherwise), and
 * the member has to be allowed to manage that server. Both must hold: a
 * member never authorizes a connection that is not theirs to hold.
 */
export function canAuthorizeCustomMcpConnection(input: {
  target: Pick<CustomMcpAuthTarget, 'ownerUserId' | 'createdByUserId'>;
  connectionUserId: string | null;
  userId: string;
  isAdmin: boolean;
}): boolean {
  if (input.connectionUserId !== input.target.ownerUserId) return false;
  return canManageCustomMcpServer(input.target, {
    userId: input.userId,
    isAdmin: input.isAdmin,
  });
}
