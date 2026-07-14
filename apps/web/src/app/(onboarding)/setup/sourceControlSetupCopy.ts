import type { SourceControlProvider } from '@roomote/types';

type SourceControlSetupCopy = {
  creationHref?: string;
  creationLinkLabel?: string;
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
      'In GitLab, go to your avatar → Edit profile → Access tokens → Add new token. Select the api scope. Use a bot or service account that belongs to the groups Roomote should access and can manage project webhooks.',
  },
  gitea: {
    setupLabel: 'Gitea access token',
    creationHint:
      'In your Gitea instance, go to your avatar → Settings → Applications → Manage Access Tokens → Generate Token. Use a bot or service account with read and write access to the repositories Roomote should use and permission to manage their webhooks.',
  },
  bitbucket: {
    creationHref: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    setupLabel: 'Bitbucket API token',
    creationHint:
      'In Atlassian account settings, select Create API token with scopes → Bitbucket. Grant repository, pull request, and webhook read and write access, plus workspace and user read access. Use a bot or service account that can manage repository webhooks.',
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
