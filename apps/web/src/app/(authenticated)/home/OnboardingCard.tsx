'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  getMcpIntegrationConnectionScope,
  isSelfServeMcpIntegration,
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
  PRODUCT_NAME,
} from '@roomote/types';

import { useAuthorizedUser } from '@/hooks/useUser';
import {
  useDeploymentMcpEnablements,
  useUserMcpConnections,
  useConnectMcp,
} from '@/hooks/mcp-connections';
import {
  useGitHubInstallations,
  useAuthenticateGitHubAccount,
} from '@/hooks/github';
import { useSlackInstallation, useConnectSlack } from '@/hooks/slack';
import { useLinearInstallation, useConnectLinear } from '@/hooks/linear';
import { useGitHubLinkedAccount } from '@/hooks/linked-accounts';
import { useTRPC } from '@/trpc/client';
import { SETTINGS_PATHS } from '@/lib/settings';

import {
  Github,
  LinearLogo,
  Slack,
  X,
  Button,
  Spinner,
  Zap,
} from '@/components/system';
import { McpIcon } from '@/components/settings/McpIcon';

const DISMISSED_KEY = 'OnboardingCardsDismissedByOrg';

type CardConfig = {
  id: string;
  icon: React.ReactNode;
  label: string;
  buttonLabel: string;
  onClick: () => void;
  disabled?: boolean;
  dismissible?: boolean;
  visible: boolean;
};

const DISMISSED_DEPLOYMENT_KEY = 'deployment';

function readDismissedCardIds(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const dismissed = parsed[DISMISSED_DEPLOYMENT_KEY];
    if (!Array.isArray(dismissed)) {
      return [];
    }

    return dismissed.filter(
      (value): value is string => typeof value === 'string',
    );
  } catch {
    return [];
  }
}

function writeDismissedCardIds(ids: string[]): void {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};

    parsed[DISMISSED_DEPLOYMENT_KEY] = ids;
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage failures.
  }
}

/**
 * Shows at most one onboarding guidance card at a time, in priority order.
 */
export function OnboardingCard() {
  const { isAdmin } = useAuthorizedUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const trpc = useTRPC();
  const shouldShowSuggestedTasksCard =
    searchParams.get('link_suggested') === 'true';

  const { data: githubInstallations = [], isPending: githubPending } =
    useGitHubInstallations();
  const { data: slackInstallation, isPending: slackPending } =
    useSlackInstallation();
  const { data: linearInstallation, isPending: linearPending } =
    useLinearInstallation();
  const { data: githubLinkedAccount, isPending: githubAccountPending } =
    useGitHubLinkedAccount();
  const enablements = useDeploymentMcpEnablements();
  const userMcpConnections = useUserMcpConnections();
  const connectMcp = useConnectMcp();
  const mcpPending = enablements.isPending || userMcpConnections.isPending;
  const { data: automationOnboardingStatus, isPending: automationsPending } =
    useQuery(trpc.automations.onboardingStatus.queryOptions());

  const promotedMcpIntegrations = mcpPending
    ? []
    : MCP_INTEGRATIONS.filter((integration) =>
        isSelfServeMcpIntegration(integration),
      )
        .map((integration, index) => ({ integration, index }))
        .filter(({ integration }) => Boolean(integration.homepageCard))
        .filter(({ integration }) =>
          isDeploymentScopedMcpIntegration(integration)
            ? isAdmin
            : (enablements.data ?? []).some(
                (entry) => entry.mcpId === integration.id && entry.enabled,
              ),
        )
        .filter(
          ({ integration }) =>
            !isDeploymentScopedMcpIntegration(integration) || isAdmin,
        )
        .filter(
          ({ integration }) =>
            !(userMcpConnections.data ?? []).some(
              (connection) =>
                connection.mcpId === integration.id &&
                connection.authStatus === 'authenticated',
            ),
        )
        .sort((left, right) => {
          const leftPriority = left.integration.homepageCard?.priority ?? 0;
          const rightPriority = right.integration.homepageCard?.priority ?? 0;

          if (leftPriority === rightPriority) {
            return left.index - right.index;
          }

          return rightPriority - leftPriority;
        })
        .map(({ integration }) => integration);

  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  const connectSlack = useConnectSlack('/', {
    onError: () => {
      toast.error('Failed to connect Slack. Please try again.');
    },
  });

  const connectLinear = useConnectLinear('/', {
    onError: () => {
      toast.error('Failed to connect Linear. Please try again.');
    },
  });

  const authenticateGitHubAccount = useAuthenticateGitHubAccount({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () =>
      toast.error('Failed to link GitHub account. Please try again.'),
  });

  const connectionToastedRef = useRef(false);

  useEffect(() => {
    if (connectionToastedRef.current) {
      return;
    }

    const slackConnected = searchParams.get('slack') === 'connected';
    const linearConnected = searchParams.get('linear') === 'connected';

    if (slackConnected || linearConnected) {
      connectionToastedRef.current = true;

      if (slackConnected) {
        toast.success('Slack connected successfully');
      }

      if (linearConnected) {
        toast.success('Linear connected successfully');
      }

      // Remove the query params from the URL without a full navigation
      const url = new URL(window.location.href);
      url.searchParams.delete('slack');
      url.searchParams.delete('linear');
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [searchParams, router]);

  useEffect(() => {
    const dismissedIds = readDismissedCardIds();
    setDismissed(
      Object.fromEntries(dismissedIds.map((cardId) => [cardId, true])),
    );
  }, []);

  const dismiss = (cardId: string) => {
    const nextDismissed = {
      ...dismissed,
      [cardId]: true,
    };

    setDismissed(nextDismissed);

    const nextDismissedIds = Object.entries(nextDismissed)
      .filter(([, isDismissed]) => isDismissed)
      .map(([id]) => id);

    writeDismissedCardIds(nextDismissedIds);
  };

  const cards: CardConfig[] = [
    {
      id: 'link-suggested-tasks',
      icon: <Spinner />,
      label: 'Your selected tasks have started.',
      buttonLabel: 'Check their progress',
      onClick: () => {
        router.push('/tasks');
      },
      dismissible: false,
      visible: shouldShowSuggestedTasksCard,
    },
    {
      id: 'slack',
      icon: (
        <Slack
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1}
        />
      ),
      label: 'Chat with Roomote on Slack',
      buttonLabel: 'Do it',
      onClick: () => {
        void (async () => {
          try {
            const url = await connectSlack.mutateAsync();

            if (url) {
              window.location.href = url;
            }
          } catch {
            // Error handled by onError.
          }
        })();
      },
      disabled: connectSlack.isPending,
      visible: !slackPending && !slackInstallation,
    },
    {
      id: 'linear',
      icon: (
        <LinearLogo
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1}
        />
      ),
      label: 'Assign tasks to agents from Linear',
      buttonLabel: 'Do it',
      onClick: () => {
        void (async () => {
          try {
            const url = await connectLinear.mutateAsync();

            if (url) {
              window.location.href = url;
            }
          } catch {
            // Error handled by onError.
          }
        })();
      },
      disabled: connectLinear.isPending,
      visible: !linearPending && !linearInstallation,
    },
    {
      id: 'github-account',
      icon: (
        <Github
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1}
        />
      ),
      label: `Link your GitHub so ${PRODUCT_NAME} acts as you`,
      buttonLabel: 'Do it',
      onClick: () => {
        void (async () => {
          try {
            const result = await authenticateGitHubAccount.mutateAsync({
              redirect: '/',
              callbackBackground: 'background',
            });

            if (result.success) {
              window.location.href = result.url;
            }
          } catch {
            // Error handled by onError.
          }
        })();
      },
      disabled: authenticateGitHubAccount.isPending,
      visible:
        !githubPending &&
        !githubAccountPending &&
        githubInstallations.length > 0 &&
        !githubLinkedAccount,
    },
  ];

  cards.push(
    ...promotedMcpIntegrations.map((integration) => ({
      id: `${integration.id}-connect`,
      icon: <McpIcon icon={integration.icon} name={integration.name} />,
      label:
        integration.homepageCard?.label ??
        (getMcpIntegrationConnectionScope(integration) === 'deployment'
          ? `Connect ${integration.name} so Roomote can access it`
          : `Connect ${integration.name} so Roomote can access it`),
      buttonLabel: integration.homepageCard?.buttonLabel ?? 'Connect',
      onClick: () => {
        connectMcp.mutate(
          { mcpId: integration.id, redirectTo: '/' },
          {
            onSuccess: (url) => {
              window.location.href = url;
            },
            onError: () => {
              toast.error(
                `Failed to connect ${integration.name}. Please try again.`,
              );
            },
          },
        );
      },
      disabled: connectMcp.isPending,
      visible: true,
    })),
  );

  cards.push({
    id: 'automations',
    icon: (
      <Zap className="size-4 shrink-0 text-muted-foreground" strokeWidth={1} />
    ),
    label: 'Automations keep your repos moving in the background',
    buttonLabel: 'Set them up',
    onClick: () => {
      router.push(SETTINGS_PATHS.automations);
    },
    visible:
      !automationsPending &&
      Boolean(automationOnboardingStatus) &&
      !automationOnboardingStatus?.hasEnabledAutomations,
  });

  const activeCard = cards.find((card) => card.visible && !dismissed[card.id]);

  if (!activeCard) {
    return null;
  }

  return (
    <>
      <div className="flex  md:w-fit md:items-center gap-2 py-1 pl-1 md:pr-5 text-sm">
        <span className="mt-1 md:mt-0">{activeCard.icon}</span>
        <div className="flex gap-1 flex-col items-start md:flex-row md:items-center md:gap-2 grow">
          <span className="flex gap-1 items-start flex-nowrap w-full">
            <span className="cursor-default font-medium text-muted-foreground grow">
              {activeCard.label}
            </span>
            {activeCard.dismissible !== false && (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="md:hidden ml-auto text-muted-foreground hover:text-foreground"
                onClick={() => dismiss(activeCard.id)}
                aria-label="Dismiss"
              >
                <X className="size-3.5" />
              </Button>
            )}
          </span>
          <Button
            variant="default"
            size="xs"
            type="button"
            onClick={activeCard.onClick}
            disabled={activeCard.disabled}
          >
            {activeCard.buttonLabel}
          </Button>
          {activeCard.dismissible !== false && (
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="hidden md:inline-flex ml-auto text-muted-foreground hover:text-foreground"
              onClick={() => dismiss(activeCard.id)}
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
