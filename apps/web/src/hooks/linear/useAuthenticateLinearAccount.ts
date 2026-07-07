import { useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

/**
 * Hook to initiate the user-level Linear OAuth flow for account linking.
 * Redirects the browser into the generic MCP OAuth flow with the
 * Linear user-link role (actor=user) instead of the deployment-level app install.
 *
 * The mutate argument is the redirect path after successful linking
 * (e.g., '/onboarding?step=linear').
 */
export const useAuthenticateLinearAccount = () => {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: async (redirectPath: string) => {
      const path = await trpcClient.mcpConnections.connect.mutate({
        mcpId: 'linear',
        role: 'linear_user_link',
        redirectTo: redirectPath,
      });

      window.location.href = new URL(path, window.location.origin).toString();

      // Return a never-resolving promise so the mutation stays in "pending"
      // state while the browser navigates away
      return new Promise<void>(() => {});
    },
  });
};
