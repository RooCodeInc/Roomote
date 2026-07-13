import type { SourceControlProvider } from '@roomote/types';

type SourceControlSetupCopy = {
  creationHref: string;
  setupLabel: string;
  /** Indefinite article for `setupLabel` ("a" unless the label needs "an"). */
  setupLabelArticle?: 'a' | 'an';
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
  bitbucket: {
    creationHref: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    setupLabel: 'Bitbucket API token',
    creationHint:
      'Create an API token with scopes covering repository, pull request, and webhook read/write, plus workspace read (read:workspace:bitbucket) and user read (read:user:bitbucket) so Roomote can discover workspaces and validate the credentials. Prefer a bot or service account that can administer repository webhooks; Roomote syncs repositories and configures pull request webhooks automatically. The Atlassian account email that owns the API token is required.',
  },
  ado: {
    creationHref: 'https://dev.azure.com/_usersSettings/tokens',
    setupLabel: 'Azure DevOps connection',
    setupLabelArticle: 'an',
    creationHint:
      'Choose a PAT for the fastest setup, connect your Microsoft account for delegated access, or use a Microsoft Entra service principal for short-lived app-only tokens. PATs should use Code read & write scopes and permission to manage service hook subscriptions for the projects Roomote should access. The organization is the slug from your https://dev.azure.com/<organization> URL. Webhook secrets are generated automatically when service hooks are configured.',
  },
};

export function getSourceControlSetupCopy(
  provider: SourceControlProvider,
): SourceControlSetupCopy {
  return SOURCE_CONTROL_SETUP_COPY[provider];
}
