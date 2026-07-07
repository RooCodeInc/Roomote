import type { SourceControlProvider } from '@roomote/types';

type SourceControlSetupCopy = {
  creationHref: string;
  setupLabel: string;
  creationHint?: string;
};

const SOURCE_CONTROL_SETUP_COPY: Record<
  SourceControlProvider,
  SourceControlSetupCopy
> = {
  github: {
    creationHref: 'https://github.com/settings/apps/new',
    setupLabel: 'GitHub App',
  },
  gitlab: {
    creationHref: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    setupLabel: 'GitLab access token',
    creationHint:
      'Create the token with the api scope. Prefer a bot or service account that is a member of the groups Roomote should access; Roomote syncs its projects and configures merge request webhooks automatically.',
  },
  gitea: {
    creationHref: 'https://docs.gitea.com/development/api-usage',
    setupLabel: 'Gitea access token',
    creationHint:
      'Create the token with repository access on the instance Roomote should use. Prefer a bot or service account that can administer repository webhooks; Roomote syncs repositories and configures pull request webhooks automatically.',
  },
  ado: {
    creationHref: 'https://dev.azure.com/_usersSettings/tokens',
    setupLabel: 'Azure DevOps personal access token',
    creationHint:
      'Create the PAT with Code access and permission to manage service hook subscriptions for the projects Roomote should access. Roomote syncs repositories and configures pull request service hooks automatically.',
  },
};

export function getSourceControlSetupCopy(
  provider: SourceControlProvider,
): SourceControlSetupCopy {
  return SOURCE_CONTROL_SETUP_COPY[provider];
}
