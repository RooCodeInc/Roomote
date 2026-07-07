import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkGiteaLinkedAccount = createUseUnlinkOAuthLinkedAccount({
  providerId: 'gitea',
  providerName: 'Gitea',
  createQueryKey: (trpc) => trpc.linkedAccounts.gitea.queryKey(),
});
