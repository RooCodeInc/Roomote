import { PRODUCT_NAME, getGitHubAppMention } from './constants';

export const invocationProviders = [
  'slack',
  'microsoft',
  'telegram',
  'discord',
  'github',
  'linear',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
] as const;

export type InvocationProvider = (typeof invocationProviders)[number];

export type InvocationIdentity = {
  provider: InvocationProvider;
  label: string;
  configured: boolean;
  displayName: string | null;
  mentionText: string | null;
  nativeMention: string | null;
  deepLinkUrl: string | null;
  guidanceName: string;
  examplePrompt: string | null;
};

export function normalizeMentionHandle(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function buildGenericInvocationIdentity(
  provider: InvocationProvider,
  label: string,
): InvocationIdentity {
  return {
    provider,
    label,
    configured: false,
    displayName: null,
    mentionText: null,
    nativeMention: null,
    deepLinkUrl: null,
    guidanceName: label,
    examplePrompt: null,
  };
}

export function buildGitHubInvocationIdentity(
  slug: string | null | undefined,
): InvocationIdentity {
  const normalizedSlug = slug?.trim() || 'roomote';
  const mentionText = getGitHubAppMention(normalizedSlug);

  return {
    provider: 'github',
    label: 'GitHub',
    configured: Boolean(slug?.trim()),
    displayName: normalizedSlug,
    mentionText,
    nativeMention: mentionText,
    deepLinkUrl: null,
    guidanceName: mentionText,
    examplePrompt: `${mentionText} address the PR feedback above`,
  };
}

export function buildTelegramInvocationIdentity(
  username: string | null | undefined,
): InvocationIdentity {
  const normalizedUsername = username?.trim().replace(/^@/, '') || null;
  const mentionText = normalizedUsername
    ? normalizeMentionHandle(normalizedUsername)
    : null;

  return {
    provider: 'telegram',
    label: 'Telegram',
    configured: Boolean(normalizedUsername),
    displayName: normalizedUsername,
    mentionText,
    nativeMention: mentionText,
    deepLinkUrl: normalizedUsername
      ? `https://t.me/${normalizedUsername}`
      : null,
    guidanceName: mentionText ?? 'Telegram bot',
    examplePrompt: mentionText
      ? `${mentionText} Add support for a reset password flow.`
      : null,
  };
}

export function buildDiscordInvocationIdentity(input: {
  botUserId: string | null | undefined;
  username: string | null | undefined;
  displayName?: string | null;
}): InvocationIdentity {
  const botUserId = input.botUserId?.trim() || null;
  const username = input.username?.trim().replace(/^@/u, '') || null;
  const displayName = input.displayName?.trim() || username;
  const mentionText = username ? normalizeMentionHandle(username) : null;
  const nativeMention = botUserId ? `<@${botUserId}>` : null;

  return {
    provider: 'discord',
    label: 'Discord',
    configured: Boolean(botUserId && username),
    displayName,
    mentionText,
    nativeMention,
    deepLinkUrl: botUserId ? `https://discord.com/users/${botUserId}` : null,
    guidanceName: mentionText ?? 'Discord bot',
    examplePrompt: mentionText
      ? `${mentionText} Add support for a reset password flow.`
      : null,
  };
}

export function buildSlackInvocationIdentity(input: {
  botUserId: string | null | undefined;
  botName?: string | null;
  appName?: string | null;
}): InvocationIdentity {
  const displayName = input.botName?.trim() || input.appName?.trim() || null;
  const mentionText = displayName ? normalizeMentionHandle(displayName) : null;
  const nativeMention = input.botUserId?.trim()
    ? `<@${input.botUserId.trim()}>`
    : null;

  return {
    provider: 'slack',
    label: 'Slack',
    configured: Boolean(input.botUserId?.trim()),
    displayName,
    mentionText,
    nativeMention,
    deepLinkUrl: null,
    guidanceName: mentionText ?? 'Slack app',
    examplePrompt: mentionText
      ? `${mentionText} Add support for a reset password flow.`
      : null,
  };
}

export function buildTeamsInvocationIdentity(
  input:
    | string
    | null
    | undefined
    | { displayName: string | null | undefined; configured?: boolean },
): InvocationIdentity {
  const displayName =
    typeof input === 'object' && input !== null && 'displayName' in input
      ? input.displayName
      : input;
  const configured =
    typeof input === 'object' && input !== null && 'configured' in input
      ? input.configured === true
      : Boolean(displayName?.trim());
  const normalizedName = displayName?.trim() || null;
  const mentionText = normalizedName
    ? normalizeMentionHandle(normalizedName)
    : null;

  return {
    provider: 'microsoft',
    label: 'Microsoft Teams',
    configured,
    displayName: normalizedName,
    mentionText,
    nativeMention: null,
    deepLinkUrl: null,
    guidanceName: normalizedName ?? 'Teams bot',
    examplePrompt: mentionText
      ? `${mentionText} Add support for a reset password flow.`
      : null,
  };
}

export function getInvocationIdentityExample(
  identity: InvocationIdentity,
  fallback?: string,
): string | null {
  return (
    identity.examplePrompt ??
    (identity.mentionText
      ? `${identity.mentionText} ${fallback ?? `Ask ${PRODUCT_NAME} to help.`}`
      : null)
  );
}
