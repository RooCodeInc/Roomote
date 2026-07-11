import { createUseAuthenticateOAuthLinkedAccount } from './shared';

export const useAuthenticateBitbucketAccount =
  createUseAuthenticateOAuthLinkedAccount({
    providerId: 'bitbucket',
    providerName: 'Bitbucket',
  });
