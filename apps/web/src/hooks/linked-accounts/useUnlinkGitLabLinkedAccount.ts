import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkGitLabLinkedAccount = createUseUnlinkOAuthLinkedAccount({
  providerId: 'gitlab',
  providerName: 'GitLab',
  createQueryKey: (trpc) => trpc.linkedAccounts.gitlab.queryKey(),
});
