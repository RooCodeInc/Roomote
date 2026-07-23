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
};

type CommunicationProviderId = 'slack' | 'microsoft' | 'telegram' | 'discord';

const communicationProviderCopy: Record<
  CommunicationProviderId,
  {
    icon: string;
    title: string;
    description: string;
  }
> = {
  slack: {
    icon: 'slack',
    title: 'Slack',
    description:
      'In a connected channel, try: @roomote Add support for a reset password flow.',
  },
  microsoft: {
    icon: 'teams',
    title: 'Microsoft Teams',
    description:
      'In a connected channel, try: @roomote Add support for a reset password flow.',
  },
  telegram: {
    icon: 'telegram',
    title: 'Telegram',
    description: 'Try: @roomote Add support for a reset password flow.',
  },
  discord: {
    icon: 'discord',
    title: 'Discord',
    description: 'Try: @roomote Add support for a reset password flow.',
  },
};

const sourceControlProviderCopy: Record<
  SourceControlProvider,
  {
    icon: string;
    description: string;
  }
> = {
  github: {
    icon: 'github',
    description:
      'On a pull request, comment: @roomote address the feedback above.',
  },
  gitlab: {
    icon: 'gitlab',
    description:
      'On a merge request, comment: @roomote address the feedback above.',
  },
  gitea: {
    icon: 'gitea',
    description:
      'On a pull request, comment: @roomote address the feedback above.',
  },
  bitbucket: {
    icon: 'bitbucket',
    description:
      'On a pull request, comment: @roomote address the feedback above.',
  },
  ado: {
    icon: 'ado',
    description:
      'On a connected pull request, ask Roomote to address the feedback above.',
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

const communicationInvocationProviderById = {
  slack: 'slack',
  microsoft: 'microsoft',
  telegram: 'telegram',
  discord: 'discord',
} as const satisfies Record<CommunicationProviderId, InvocationProvider>;

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
  includeAutomations = true,
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
  includeAutomations?: boolean;
  invocationIdentities?: readonly InvocationIdentity[];
}): InvokeMethod[] {
  return [
    ...uniqueValues(communicationProviders).map((provider) => {
      const copy = communicationProviderCopy[provider];
      const identity = getIdentity(
        invocationIdentities,
        communicationInvocationProviderById[provider],
      );

      return {
        icon: createBrandIcon(copy.icon, copy.title),
        title: copy.title,
        description: identity?.examplePrompt
          ? `Try: ${identity.examplePrompt}`
          : copy.description,
      };
    }),
    ...uniqueValues(sourceControlProviders).map((provider) => {
      const copy = sourceControlProviderCopy[provider];
      const title = getSourceControlProviderLabel(provider);
      const identity = getIdentity(
        invocationIdentities,
        sourceControlInvocationProviderById[provider],
      );
      const description = identity?.examplePrompt
        ? `On a pull request, comment: ${identity.examplePrompt}`
        : copy.description;

      return {
        icon: createBrandIcon(copy.icon, title),
        title,
        description,
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
    ...(includeAutomations
      ? [
          {
            icon: Zap,
            title: 'Automations',
            description: `Let ${PRODUCT_NAME} work proactively for you, handling alerts, taking on tasks and finding issues. No prompting needed, look at the Automations tab.`,
          },
        ]
      : []),
    {
      icon: AppWindow,
      title: 'Web UI',
      description: 'Simply prompt from the home page.',
    },
  ];
}
