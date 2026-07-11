'use client';

import type { ComponentType } from 'react';
import {
  getSourceControlProviderLabel,
  PRODUCT_NAME,
  type InvocationIdentity,
  type InvocationProvider,
  type SourceControlProvider,
} from '@roomote/types';
import { AppWindow, BrandIcon, LinearLogo, Zap } from '@/components/system';

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
  },
  microsoft: {
    icon: 'teams',
    title: 'Microsoft Teams',
    description: `talk to it directly, or mention it in any connected channel.`,
  },
  telegram: {
    icon: 'telegram',
    title: 'Telegram',
    description: `start work from any connected chats.`,
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
    description: `Mention the GitHub app in a comment on any PR.`,
  },
  gitlab: {
    icon: 'gitlab',
    description: `Start work from connected GitLab merge requests and repositories.`,
  },
  gitea: {
    icon: 'gitea',
    description: `Start work from connected Gitea pull requests and repositories.`,
  },
  bitbucket: {
    icon: 'bitbucket',
    description: `Start work from connected Bitbucket pull requests and repositories.`,
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

const sourceControlInvocationProviderById = {
  github: 'github',
  gitlab: 'gitlab',
  gitea: 'gitea',
  bitbucket: 'bitbucket',
  ado: 'ado',
} as const satisfies Record<SourceControlProvider, InvocationProvider>;

function getIdentity(
  identities: readonly InvocationIdentity[] | undefined,
  provider: InvocationProvider,
) {
  return identities?.find((identity) => identity.provider === provider);
}

export function buildInvokeMethods({
  communicationProviders = [],
  sourceControlProviders = [],
  includeLinear = false,
  invocationIdentities = [],
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
  invocationIdentities?: readonly InvocationIdentity[];
}): InvokeMethod[] {
  return [
    ...uniqueValues(communicationProviders).map((provider) => {
      const copy = communicationProviderCopy[provider];
      const identity = getIdentity(invocationIdentities, provider);

      return {
        icon: createBrandIcon(copy.icon, copy.title),
        title: copy.title,
        description: copy.description,
        ...(identity?.examplePrompt ? { example: identity.examplePrompt } : {}),
      };
    }),
    ...uniqueValues(sourceControlProviders).map((provider) => {
      const copy = sourceControlProviderCopy[provider];
      const title = getSourceControlProviderLabel(provider);
      const identity = getIdentity(
        invocationIdentities,
        sourceControlInvocationProviderById[provider],
      );
      const description = identity?.mentionText
        ? `Mention ${identity.mentionText} in a comment on any PR.`
        : copy.description;

      return {
        icon: createBrandIcon(copy.icon, title),
        title,
        description,
        ...(identity?.examplePrompt ? { example: identity.examplePrompt } : {}),
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
