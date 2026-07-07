import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { authClient } from '@/lib/auth-client';
import { useTRPC } from '@/trpc/client';

type LinkedAccountsTrpc = ReturnType<typeof useTRPC>;

type OAuthLinkedAccountConfig = {
  providerId: string;
  providerName: string;
};

type LinkedAccountQueryKeyFactory = (trpc: LinkedAccountsTrpc) => QueryKey;

type UnlinkLinkedAccountResult =
  | { success: true }
  | { success: false; error: string };

export function createUseAuthenticateOAuthLinkedAccount({
  providerId,
  providerName,
}: OAuthLinkedAccountConfig) {
  return function useAuthenticateOAuthLinkedAccount() {
    return useMutation({
      mutationFn: async (redirectPath: string) => {
        const result = await authClient.oauth2.link({
          providerId,
          callbackURL: redirectPath,
          errorCallbackURL: redirectPath,
        });

        if (result.error) {
          throw new Error(
            result.error.message ?? `Failed to link ${providerName} account.`,
          );
        }

        if (!result.data?.url) {
          throw new Error(
            `${providerName} account link did not return a redirect URL.`,
          );
        }

        window.location.href = result.data.url;

        return new Promise<void>(() => {});
      },
    });
  };
}

export function createUseUnlinkOAuthLinkedAccount({
  providerId,
  providerName,
  createQueryKey,
}: OAuthLinkedAccountConfig & {
  createQueryKey: LinkedAccountQueryKeyFactory;
}) {
  return function useUnlinkOAuthLinkedAccount() {
    const trpc = useTRPC();
    const queryClient = useQueryClient();

    return useMutation<UnlinkLinkedAccountResult, Error, string>({
      mutationFn: async (accountId) => {
        const result = await authClient.unlinkAccount({
          accountId,
          providerId,
        });

        if (result.error || !result.data?.status) {
          return {
            success: false,
            error:
              result.error?.message ??
              `Failed to unlink ${providerName} account.`,
          };
        }

        return { success: true };
      },
      onSuccess: async (result) => {
        if (!result.success) {
          return;
        }

        await queryClient.invalidateQueries({
          queryKey: createQueryKey(trpc),
        });
      },
    });
  };
}
