'use client';

import type { ComponentType } from 'react';
import {
  getGitHubAppMention,
  getSourceControlProviderLabel,
  PRODUCT_NAME,
  type SourceControlProvider,
} from '@roomote/types';
import { AppWindow, BrandIcon, LinearLogo, Zap } from '@/components/system';

const githubAppMention = getGitHubAppMention(
  process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || 'roomote',
);

type MethodIcon = ComponentType<{ className?: string }>;

type InvokeMethod = {
  icon: MethodIcon;
  title: string;
  description: string;
  example?: string;
};

type CommunicationProviderId = 'slack' | 'microsoft' | 'telegram';

const communicationProviderCopy: Record<
  CommunicationProviderId,
  {
    icon: string;
    title: string;
    description: string;
    example?: string;
  }
> = {
  slack: {
    icon: 'slack',
    title: 'Slack',
    description: `talk to it directly, or mention it in any connected channel.`,
    example: `@Roomote Add support for a reset password flow.`,
  },
  microsoft: {
    icon: 'teams',
    title: 'Microsoft Teams',
    description: `talk to it directly, or mention it in any connected channel.`,
    example: `@Roomote Add support for a reset password flow.`,
  },
  telegram: {
    icon: 'telegram',
    title: 'Telegram',
    description: `start work from any connected chats.`,
    example: `@Roomote Add support for a reset password flow.`,
  },
};

const sourceControlProviderCopy: Record<
  SourceControlProvider,
  {
    icon: string;
    description: string;
    example?: string;
  }
> = {
  github: {
    icon: 'github',
    description: `Mention ${githubAppMention} in a comment on any PR.`,
    example: `${githubAppMention} address the PR feedback above`,
  },
  gitlab: {
    icon: 'gitlab',
    description: `Start work from connected GitLab merge requests and repositories.`,
  },
  gitea: {
    icon: 'gitea',
    description: `Start work from connected Gitea pull requests and repositories.`,
  },
  ado: {
    icon: 'ado',
    description: `Start work from connected Azure DevOps pull requests and repositories.`,
  },
};

function createBrandIcon(icon: string, name: string): MethodIcon {
  return function InvokeBrandIcon({ className }: { className?: string }) {
    return <BrandIcon icon={icon} name={name} className={className} />;
  };
}

function uniqueValues<T>(values: readonly (T | null | undefined)[]): T[] {
  return values.filter((value, index): value is T => {
    return value != null && values.indexOf(value) === index;
  });
}

export function buildInvokeMethods({
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
}: {
  communicationProviders?: readonly (
    | CommunicationProviderId
    | null
    | undefined
  )[];
  sourceControlProviders?: readonly (
    | SourceControlProvider
    | null
    | undefined
  )[];
  includeLinear?: boolean;
}): InvokeMethod[] {
  return [
    ...uniqueValues(communicationProviders).map((provider) => {
      const copy = communicationProviderCopy[provider];

      return {
        icon: createBrandIcon(copy.icon, copy.title),
        title: copy.title,
        description: copy.description,
        ...(copy.example ? { example: copy.example } : {}),
      };
    }),
    ...uniqueValues(sourceControlProviders).map((provider) => {
      const copy = sourceControlProviderCopy[provider];
      const title = getSourceControlProviderLabel(provider);

      return {
        icon: createBrandIcon(copy.icon, title),
        title,
        description: copy.description,
        ...(copy.example ? { example: copy.example } : {}),
      };
    }),
    ...(includeLinear
      ? [
          {
            icon: LinearLogo,
            title: 'Linear',
            description: `Assign an issue from Linear. ${PRODUCT_NAME} will start working on it right away and report back to you.`,
          },
        ]
      : []),
    {
      icon: Zap,
      title: 'Automations',
      description: `Let ${PRODUCT_NAME} work proactively for you, handling alerts, taking on tasks and finding issues. No prompting needed.`,
    },
    {
      icon: AppWindow,
      title: 'Web UI',
      description: 'Simply prompt from the home page.',
    },
  ];
}
