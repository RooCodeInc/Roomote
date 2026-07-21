import { Env } from '@roomote/env';
import { PRODUCT_NAME } from '@roomote/types';

type SourceControlCommentProvider =
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'bitbucket'
  | 'ado';

const sourceControlCommentProviderCopy = {
  github: {
    accountLabel: 'GitHub',
    commentSurface: 'issue and PR comments',
    settingsQuery: 'github',
  },
  gitlab: {
    accountLabel: 'GitLab',
    commentSurface: 'issue and merge request comments',
    settingsQuery: 'gitlab',
  },
  gitea: {
    accountLabel: 'Gitea',
    // Gitea routes both plain-issue and PR @mentions through the same link
    // gate; keep wording provider-level so neither surface misleads.
    commentSurface: 'issue and pull request comments',
    settingsQuery: 'gitea',
  },
  bitbucket: {
    accountLabel: 'Bitbucket',
    commentSurface: 'pull request comments',
    settingsQuery: 'bitbucket',
  },
  ado: {
    accountLabel: 'Azure DevOps',
    commentSurface: 'work item and pull request comments',
    settingsQuery: 'ado',
  },
} satisfies Record<
  SourceControlCommentProvider,
  {
    accountLabel: string;
    commentSurface: string;
    settingsQuery: string;
  }
>;

function getLinkedAccountsSettingsUrl(
  provider: SourceControlCommentProvider,
): string | null {
  try {
    return new URL(
      `/settings?service=${sourceControlCommentProviderCopy[provider].settingsQuery}`,
      Env.R_APP_URL,
    ).toString();
  } catch {
    return null;
  }
}

function getEnvironmentsSettingsUrl(): string | null {
  try {
    return new URL('/settings/environments', Env.R_APP_URL).toString();
  } catch {
    return null;
  }
}

export function buildSourceControlEnvironmentRequiredMessage(
  provider: SourceControlCommentProvider,
): string {
  const copy = sourceControlCommentProviderCopy[provider];
  const settingsUrl = getEnvironmentsSettingsUrl();
  const settingsText = settingsUrl
    ? `[Settings -> Environments](${settingsUrl})`
    : 'Settings -> Environments';

  return `I saw the mention, but no Roomote environment is mapped to this ${copy.accountLabel} repository. Set up an environment and map this repository from ${settingsText}, then mention me again.`;
}

export function buildSourceControlAccountLinkRequiredMessage(
  provider: SourceControlCommentProvider,
): string {
  const copy = sourceControlCommentProviderCopy[provider];

  const settingsUrl = getLinkedAccountsSettingsUrl(provider);
  const settingsText = settingsUrl
    ? `[Settings -> Linked Accounts](${settingsUrl})`
    : 'Settings -> Linked Accounts';
  const linkInstruction = `Link it from ${settingsText} and then mention me again.`;

  if (
    provider === 'gitlab' ||
    provider === 'gitea' ||
    provider === 'bitbucket' ||
    provider === 'ado'
  ) {
    return `I saw the mention, but I need your ${copy.accountLabel} account linked to ${PRODUCT_NAME} before ${copy.commentSurface} can start work here. ${linkInstruction} If ${copy.accountLabel} is missing from Linked Accounts, ask an admin to add the ${copy.accountLabel} OAuth client credentials in Settings -> Environments -> Source Control first.`;
  }

  return `I saw the mention, but I need your ${copy.accountLabel} account linked to ${PRODUCT_NAME} before ${copy.commentSurface} can start work here. ${linkInstruction}`;
}
