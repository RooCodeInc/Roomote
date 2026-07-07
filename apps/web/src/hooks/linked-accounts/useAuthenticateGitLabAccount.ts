import { createUseAuthenticateOAuthLinkedAccount } from './shared';

export const useAuthenticateGitLabAccount =
  createUseAuthenticateOAuthLinkedAccount({
    providerId: 'gitlab',
    providerName: 'GitLab',
  });
