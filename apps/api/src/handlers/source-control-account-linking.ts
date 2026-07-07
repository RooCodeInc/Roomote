import { Env } from '@roomote/env';
import { PRODUCT_NAME } from '@roomote/types';

type SourceControlCommentProvider = 'github' | 'gitlab' | 'gitea' | 'ado';

const sourceControlCommentProviderCopy = {
  github: {
    accountLabel: 'GitHub',
    commentSurface: 'PR comments',
    settingsQuery: 'github',
  },
  gitlab: {
    accountLabel: 'GitLab',
    commentSurface: 'merge request comments',
    settingsQuery: 'gitlab',
  },
  gitea: {
    accountLabel: 'Gitea',
    commentSurface: 'pull request comments',
    settingsQuery: 'gitea',
  },
  ado: {
    accountLabel: 'Azure DevOps',
    commentSurface: 'pull request comments',
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
      Env.ROOMOTE_APP_URL,
    ).toString();
  } catch {
    return null;
  }
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

  if (provider === 'gitlab' || provider === 'gitea' || provider === 'ado') {
    return `I saw the mention, but I need your ${copy.accountLabel} account linked to ${PRODUCT_NAME} before ${copy.commentSurface} can start work here. ${linkInstruction} If ${copy.accountLabel} is missing from Linked Accounts, ask an admin to add the ${copy.accountLabel} OAuth client credentials in Settings -> Environments -> Source Control first.`;
  }

  return `I saw the mention, but I need your ${copy.accountLabel} account linked to ${PRODUCT_NAME} before ${copy.commentSurface} can start work here. ${linkInstruction}`;
}
