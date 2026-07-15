import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkBitbucketLinkedAccount =
  createUseUnlinkOAuthLinkedAccount({
    providerId: 'bitbucket',
    providerName: 'Bitbucket Cloud',
    createQueryKey: (trpc) => trpc.linkedAccounts.bitbucket.queryKey(),
  });
