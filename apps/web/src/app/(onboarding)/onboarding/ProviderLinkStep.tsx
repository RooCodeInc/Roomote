'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getGitHubAppMention, PRODUCT_NAME } from '@roomote/types';

import { useAuthenticateGitHubAccount } from '@/hooks/github';
import {
  useAuthenticateAdoAccount,
  useAuthenticateBitbucketAccount,
  useAuthenticateGiteaAccount,
  useAuthenticateGitLabAccount,
  useAuthenticateMicrosoftTeamsAccount,
  useCreateDiscordLinkCode,
  useCreateTelegramLinkCode,
  useDiscordLinkedAccount,
  useTelegramLinkedAccount,
} from '@/hooks/linked-accounts';
import { useAuthenticateSlackAccount } from '@/hooks/slack';
import { BrandIcon, Button, Spinner } from '@/components/system';

import { StepTitle } from '../setup/StepTitle';
import type { OnboardingLinkableProvider } from './types';

function SkipLink({ onContinue }: { onContinue: () => void }) {
  return (
    <button
      className="cursor-pointer text-sm text-muted-foreground underline relative left-4 -top-1"
      onClick={onContinue}
      type="button"
    >
      Do this later
    </button>
  );
}

function CodeLinkStep({
  provider,
  onContinue,
  onLinked,
}: {
  provider: 'telegram' | 'discord';
  onContinue: () => void;
  onLinked: () => void;
}) {
  const telegram = useTelegramLinkedAccount({ refetchInterval: 2_000 });
  const discord = useDiscordLinkedAccount({ refetchInterval: 2_000 });
  const createTelegramLinkCode = useCreateTelegramLinkCode();
  const createDiscordLinkCode = useCreateDiscordLinkCode();
  const [link, setLink] = useState<{
    code: string;
    expiresInSeconds: number;
    action: string;
    openUrl: string | null;
  } | null>(null);
  const linked =
    provider === 'telegram'
      ? telegram.data?.mapping !== null && telegram.data?.mapping !== undefined
      : discord.data?.mapping !== null && discord.data?.mapping !== undefined;

  useEffect(() => {
    if (linked) onLinked();
  }, [linked, onLinked]);

  const generateCode = () => {
    if (provider === 'telegram') {
      createTelegramLinkCode.mutate(undefined, {
        onSuccess: (result) =>
          setLink({
            code: result.code,
            expiresInSeconds: result.expiresInSeconds,
            action: `Send this code to the Telegram bot: ${result.code}`,
            openUrl: result.deepLink,
          }),
        onError: () => toast.error('Failed to create a Telegram link code.'),
      });
      return;
    }

    createDiscordLinkCode.mutate(undefined, {
      onSuccess: (result) =>
        setLink({
          code: result.code,
          expiresInSeconds: result.expiresInSeconds,
          action: result.command,
          openUrl: result.openDiscordUrl,
        }),
      onError: () => toast.error('Failed to create a Discord link code.'),
    });
  };

  const isPending =
    createTelegramLinkCode.isPending || createDiscordLinkCode.isPending;
  const label = provider === 'telegram' ? 'Telegram' : 'Discord';

  return (
    <div className="space-y-6 max-w-md relative">
      <StepTitle text={`Link ${label}`} showCheckbox={false} />
      <p className="text-muted-foreground">
        Link your account so work you start from {label} is attributed to you.
      </p>
      {link ? (
        <div className="space-y-3">
          <p className="text-sm">{link.action}</p>
          <code className="block rounded-md border px-3 py-2 font-mono text-sm select-all">
            {link.code}
          </code>
          <p className="text-xs text-muted-foreground">
            This code expires in {Math.round(link.expiresInSeconds / 60)}{' '}
            minutes.
          </p>
          {link.openUrl ? (
            <Button asChild variant="outline">
              <a href={link.openUrl} target="_blank" rel="noopener noreferrer">
                Open {label}
              </a>
            </Button>
          ) : null}
        </div>
      ) : (
        <Button onClick={generateCode} disabled={isPending}>
          {isPending ? <Spinner /> : <BrandIcon icon={provider} name="" />}
          Link {label} account
        </Button>
      )}
      <SkipLink onContinue={onContinue} />
    </div>
  );
}

export function ProviderLinkStep({
  provider,
  githubAppSlug,
  onContinue,
  onLinked,
}: {
  provider: OnboardingLinkableProvider;
  githubAppSlug: string;
  onContinue: () => void;
  onLinked: () => void;
}) {
  if (provider.id === 'telegram' || provider.id === 'discord') {
    return (
      <CodeLinkStep
        provider={provider.id}
        onContinue={onContinue}
        onLinked={onLinked}
      />
    );
  }

  return (
    <OAuthLinkStep
      provider={provider}
      githubAppSlug={githubAppSlug}
      onContinue={onContinue}
    />
  );
}

function OAuthLinkStep({
  provider,
  githubAppSlug,
  onContinue,
}: {
  provider: Exclude<OnboardingLinkableProvider, { id: 'telegram' | 'discord' }>;
  githubAppSlug: string;
  onContinue: () => void;
}) {
  const authenticateSlack = useAuthenticateSlackAccount();
  const authenticateGitHub = useAuthenticateGitHubAccount();
  const authenticateGitLab = useAuthenticateGitLabAccount();
  const authenticateGitea = useAuthenticateGiteaAccount();
  const authenticateBitbucket = useAuthenticateBitbucketAccount();
  const authenticateAdo = useAuthenticateAdoAccount();
  const authenticateMicrosoftTeams = useAuthenticateMicrosoftTeamsAccount();
  const redirect = `/onboarding?step=${provider.id}`;

  const openRedirect = (
    result: { success: true; url: string } | { success: false; error: string },
  ) => {
    if (result.success) {
      window.location.href = result.url;
    } else {
      toast.error(result.error);
    }
  };

  const link = () => {
    switch (provider.id) {
      case 'slack':
        authenticateSlack.mutate(redirect, {
          onSuccess: openRedirect,
          onError: () =>
            toast.error('Failed to link Slack account. Please try again.'),
        });
        return;
      case 'github':
        authenticateGitHub.mutate(
          { redirect, callbackBackground: 'background' },
          {
            onSuccess: openRedirect,
            onError: () =>
              toast.error('Failed to link GitHub account. Please try again.'),
          },
        );
        return;
      case 'gitlab':
        authenticateGitLab.mutate(redirect, {
          onError: () =>
            toast.error('Failed to link GitLab account. Please try again.'),
        });
        return;
      case 'gitea':
        authenticateGitea.mutate(redirect, {
          onError: () =>
            toast.error('Failed to link Gitea account. Please try again.'),
        });
        return;
      case 'bitbucket':
        authenticateBitbucket.mutate(redirect, {
          onError: () =>
            toast.error(
              'Failed to link Bitbucket Cloud account. Please try again.',
            ),
        });
        return;
      case 'ado':
        authenticateAdo.mutate(redirect, {
          onError: () =>
            toast.error(
              'Failed to link Azure DevOps account. Please try again.',
            ),
        });
        return;
      case 'microsoft':
        authenticateMicrosoftTeams.mutate(redirect, {
          onError: () =>
            toast.error(
              'Failed to link Microsoft Teams account. Please try again.',
            ),
        });
        return;
    }
  };

  const isPending =
    authenticateSlack.isPending ||
    authenticateGitHub.isPending ||
    authenticateGitLab.isPending ||
    authenticateGitea.isPending ||
    authenticateBitbucket.isPending ||
    authenticateAdo.isPending ||
    authenticateMicrosoftTeams.isPending;
  const githubMention =
    provider.id === 'github' ? getGitHubAppMention(githubAppSlug) : null;

  return (
    <div className="space-y-6 max-w-md relative">
      <StepTitle text={`Link ${provider.label}`} showCheckbox={false} />
      <p className="text-muted-foreground">
        {githubMention
          ? `${PRODUCT_NAME} PRs and comments are published by ${githubMention} by default. Link your account to receive credit for your work.`
          : `Link your ${provider.label} account to use it directly with ${PRODUCT_NAME}.`}
      </p>
      <Button onClick={link} disabled={isPending}>
        {isPending ? (
          <Spinner />
        ) : (
          <BrandIcon
            icon={provider.id === 'microsoft' ? 'teams' : provider.id}
            name=""
          />
        )}
        Link {provider.label} account
      </Button>
      <SkipLink onContinue={onContinue} />
    </div>
  );
}
