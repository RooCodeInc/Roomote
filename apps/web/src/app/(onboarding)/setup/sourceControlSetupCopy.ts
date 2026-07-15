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
    creationHref: 'https://gitlab.com/-/user_settings/applications',
    setupLabel: 'GitLab OAuth application',
    creationHint:
      'In GitLab, click on your avatar → Edit Profile → Applications → Add new application, granting the API read/write scope.',
  },
  gitea: {
    setupLabel: 'Gitea OAuth application',
    creationHint:
      'In Gitea 1.23+, go to your org → Settings → Application → New OAuth2 app.',
  },
  bitbucket: {
    creationHref: 'https://developer.atlassian.com/console/myapps/',
    setupLabel: 'Bitbucket OAuth consumer',
    creationHint:
      'Create an OAuth consumer in the Atlassian developer console, set the callback URL to this deployment, and grant account, repository, pull request, and webhook read/write scopes.',
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
