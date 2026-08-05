'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { MCP_INTEGRATIONS } from '@roomote/types';

import { useAuthorizedUser } from '@/hooks/useUser';
import {
  useDeploymentMcpEnablements,
  useUserMcpConnections,
  useConnectMcp,
} from '@/hooks/mcp-connections';
import { useAuthenticateGitHubAccount } from '@/hooks/github';
import { useAuthenticateSlackAccount } from '@/hooks/slack';
import { useAuthenticateLinearAccount } from '@/hooks/linear';
import {
  useAuthenticateAdoAccount,
  useAuthenticateBitbucketAccount,
  useAuthenticateGiteaAccount,
  useAuthenticateGitLabAccount,
  useAuthenticateMicrosoftTeamsAccount,
} from '@/hooks/linked-accounts';
import { useTRPC } from '@/trpc/client';
import { SETTINGS_PATHS } from '@/lib/settings';

import {
  BookMarked,
  BrandIcon,
  Check,
  ChevronDown,
  ChevronUp,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Github,
  LinearLogo,
  Mail,
  Skeleton,
  Slack,
  X,
  Button,
  Zap,
} from '@/components/system';
import { McpIcon } from '@/components/settings/McpIcon';
import { DiscordLinkAccountStep } from '@/components/settings/DiscordLinkAccountStep';
import { TelegramLinkAccountStep } from '@/components/settings/TelegramLinkAccountStep';
import { DOCS_COOKBOOK_URL } from '@/lib/docs';

const DISMISSED_KEY = 'OnboardingCardsDismissedByOrg';
const DISMISSED_DEPLOYMENT_KEY = 'deployment';
const COLLAPSED_KEY = 'home-onboarding-pane-collapsed';

const ADMIN_INTEGRATION_ORDER = [
  'notion',
  'linear',
  'jira',
  'sentry',
  'grafana',
] as const;

const PERSONAL_MCP_INTEGRATION_ORDER = ['notion'] as const;

const CARD_EXIT_TRANSITION = {
  duration: 0.4,
  ease: 'easeOut',
} as const;

const CARD_ENTER_TRANSITION = {
  duration: 0.4,
  delay: 0.25,
  ease: 'easeOut',
} as const;

const CARD_ANIMATION = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0, transition: CARD_ENTER_TRANSITION },
  exit: { opacity: 0, y: -20, transition: CARD_EXIT_TRANSITION },
} as const;

const COMMUNICATION_PROVIDER_ORDER = [
  'slack',
  'microsoft',
  'telegram',
  'discord',
] as const;

const SOURCE_CONTROL_PROVIDER_ORDER = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
] as const;

type CardConfig = {
  id: string;
  icon: ReactNode;
  label: string;
  buttonLabel: string;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  dismissible?: boolean;
  visible: boolean;
};

type LinkableProviderId =
  | 'slack'
  | 'microsoft'
  | 'telegram'
  | 'discord'
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'bitbucket'
  | 'ado';

function readDismissedCardIds(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const dismissed = parsed[DISMISSED_DEPLOYMENT_KEY];
    return Array.isArray(dismissed)
      ? dismissed.filter((value): value is string => typeof value === 'string')
      : [];
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

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  } catch {
    // Ignore localStorage failures.
  }
}

function getMcpIntegration(id: string) {
  const integration = MCP_INTEGRATIONS.find((entry) => entry.id === id);
  if (!integration) throw new Error(`Unknown MCP integration: ${id}`);
  return integration;
}

function OnboardingCardRow({
  card,
  onDismiss,
}: {
  card: CardConfig;
  onDismiss: () => void;
}) {
  const action = card.href ? (
    <Button asChild variant="default" size="xs">
      <a
        href={card.href}
        target={card.external ? '_blank' : undefined}
        rel={card.external ? 'noopener noreferrer' : undefined}
      >
        {card.buttonLabel}
      </a>
    </Button>
  ) : (
    <Button
      variant="default"
      size="xs"
      type="button"
      onClick={card.onClick}
      disabled={card.disabled}
    >
      {card.buttonLabel}
    </Button>
  );

  return (
    <motion.div
      key={card.id}
      initial="initial"
      animate="animate"
      exit="exit"
      variants={CARD_ANIMATION}
      className="flex min-w-0 items-start gap-2 py-1 pl-1 text-sm md:items-center"
    >
      <span className="mt-0.5 shrink-0 md:mt-0">{card.icon}</span>
      <div className="flex min-w-0 grow flex-col items-start gap-1 md:flex-row md:items-center md:gap-2">
        <span className="flex w-full min-w-0 items-start gap-1">
          <span className="grow cursor-default font-medium text-muted-foreground">
            {card.label}
          </span>
          {card.dismissible !== false ? (
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="ml-auto text-muted-foreground hover:text-foreground md:hidden"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </span>
        {action}
        {card.dismissible !== false ? (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="ml-auto hidden text-muted-foreground hover:text-foreground md:inline-flex"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}

function OnboardingLane({
  cards,
  dismissed,
  onDismiss,
  pending = false,
}: {
  cards: CardConfig[];
  dismissed: Record<string, boolean>;
  onDismiss: (cardId: string) => void;
  pending?: boolean;
}) {
  const activeCard = cards.find((card) => card.visible && !dismissed[card.id]);

  return (
    <div className="relative min-w-0 overflow-clip">
      <AnimatePresence initial={false} mode="popLayout">
        {pending ? (
          <Skeleton key="pending" className="my-1 h-8 w-full" />
        ) : activeCard ? (
          <OnboardingCardRow
            key={activeCard.id}
            card={activeCard}
            onDismiss={() => onDismiss(activeCard.id)}
          />
        ) : (
          <motion.div
            key="all-set"
            initial="initial"
            animate="animate"
            exit="exit"
            variants={CARD_ANIMATION}
            className="flex items-center gap-2 py-2 pl-1 text-sm font-medium text-muted-foreground"
          >
            <Check className="size-4" />
            <span>You&apos;re all set</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Shows the highest-priority task and ambient onboarding guidance together. */
export function OnboardingPane() {
  const { isAdmin } = useAuthorizedUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const trpc = useTRPC();
  const onboarding = useQuery(trpc.onboarding.status.queryOptions());
  const enablements = useDeploymentMcpEnablements();
  const userMcpConnections = useUserMcpConnections();
  const connectMcp = useConnectMcp();
  const { data: automationOnboardingStatus, isPending: automationsPending } =
    useQuery(trpc.automations.onboardingStatus.queryOptions());

  const authenticateSlackAccount = useAuthenticateSlackAccount();
  const authenticateGitHubAccount = useAuthenticateGitHubAccount();
  const authenticateLinearAccount = useAuthenticateLinearAccount();
  const authenticateMicrosoftTeamsAccount =
    useAuthenticateMicrosoftTeamsAccount();
  const authenticateGitLabAccount = useAuthenticateGitLabAccount();
  const authenticateGiteaAccount = useAuthenticateGiteaAccount();
  const authenticateBitbucketAccount = useAuthenticateBitbucketAccount();
  const authenticateAdoAccount = useAuthenticateAdoAccount();
  const [linkDialog, setLinkDialog] = useState<'telegram' | 'discord' | null>(
    null,
  );
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const connectionToastedRef = useRef(false);

  useEffect(() => {
    if (connectionToastedRef.current) return;

    const slackConnected = searchParams.get('slack') === 'connected';
    const linearConnected = searchParams.get('linear') === 'connected';
    if (!slackConnected && !linearConnected) return;

    connectionToastedRef.current = true;
    if (slackConnected) toast.success('Slack account linked successfully');
    if (linearConnected) toast.success('Linear account linked successfully');

    const url = new URL(window.location.href);
    url.searchParams.delete('slack');
    url.searchParams.delete('linear');
    router.replace(url.pathname + url.search, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    const dismissedIds = readDismissedCardIds();
    setDismissed(
      Object.fromEntries(dismissedIds.map((cardId) => [cardId, true])),
    );
  }, []);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const dismiss = (cardId: string) => {
    setDismissed((currentDismissed) => {
      const nextDismissed = { ...currentDismissed, [cardId]: true };
      writeDismissedCardIds(
        Object.entries(nextDismissed)
          .filter(([, isDismissed]) => isDismissed)
          .map(([id]) => id),
      );
      return nextDismissed;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((currentCollapsed) => {
      const nextCollapsed = !currentCollapsed;
      writeCollapsed(nextCollapsed);
      return nextCollapsed;
    });
  };

  const startOAuthLink = (
    name: string,
    mutation: {
      mutate: (redirect: string, options?: { onError: () => void }) => void;
    },
  ) => {
    mutation.mutate('/', {
      onError: () => toast.error(`Failed to link ${name}. Please try again.`),
    });
  };

  const linkProvider = (providerId: LinkableProviderId) => {
    switch (providerId) {
      case 'slack':
        authenticateSlackAccount.mutate('/', {
          onSuccess: (result) => {
            if (result.success) window.location.href = result.url;
            else toast.error(result.error);
          },
          onError: () => toast.error('Failed to link Slack. Please try again.'),
        });
        return;
      case 'github':
        authenticateGitHubAccount.mutate(
          { redirect: '/', callbackBackground: 'background' },
          {
            onSuccess: (result) => {
              if (result.success) window.location.href = result.url;
              else toast.error(result.error);
            },
            onError: () =>
              toast.error('Failed to link GitHub. Please try again.'),
          },
        );
        return;
      case 'microsoft':
        startOAuthLink('Microsoft Teams', authenticateMicrosoftTeamsAccount);
        return;
      case 'gitlab':
        startOAuthLink('GitLab', authenticateGitLabAccount);
        return;
      case 'gitea':
        startOAuthLink('Gitea', authenticateGiteaAccount);
        return;
      case 'bitbucket':
        startOAuthLink('Bitbucket Cloud', authenticateBitbucketAccount);
        return;
      case 'ado':
        startOAuthLink('Azure DevOps', authenticateAdoAccount);
        return;
      case 'telegram':
      case 'discord':
        setLinkDialog(providerId);
    }
  };

  const isProviderLinkPending = (providerId: LinkableProviderId) => {
    switch (providerId) {
      case 'slack':
        return authenticateSlackAccount.isPending;
      case 'github':
        return authenticateGitHubAccount.isPending;
      case 'microsoft':
        return authenticateMicrosoftTeamsAccount.isPending;
      case 'gitlab':
        return authenticateGitLabAccount.isPending;
      case 'gitea':
        return authenticateGiteaAccount.isPending;
      case 'bitbucket':
        return authenticateBitbucketAccount.isPending;
      case 'ado':
        return authenticateAdoAccount.isPending;
      default:
        return false;
    }
  };

  const status = onboarding.data;
  const isIntegrationsPending =
    onboarding.isPending ||
    enablements.isPending ||
    userMcpConnections.isPending;
  const enabledMcpIds = new Set(
    (enablements.data ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => entry.mcpId),
  );
  const authenticatedMcpIds = new Set(
    (userMcpConnections.data ?? [])
      .filter((connection) => connection.authStatus === 'authenticated')
      .map((connection) => connection.mcpId),
  );

  const providerIcon = (providerId: LinkableProviderId) => {
    switch (providerId) {
      case 'slack':
        return (
          <Slack
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1}
          />
        );
      case 'github':
        return (
          <Github
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1}
          />
        );
      case 'microsoft':
        return (
          <BrandIcon icon="teams" name="Microsoft Teams" className="size-4" />
        );
      default: {
        const icon = providerId === 'ado' ? 'ado' : providerId;
        const name =
          providerId === 'bitbucket' ? 'Bitbucket Cloud' : providerId;
        return <BrandIcon icon={icon} name={name} className="size-4" />;
      }
    }
  };

  const providerCards: CardConfig[] = (status?.linkableProviders ?? []).map(
    (provider) => ({
      id: `link-${provider.id}`,
      icon: providerIcon(provider.id as LinkableProviderId),
      label: `Link your ${provider.label} account`,
      buttonLabel: 'Link',
      onClick: () => linkProvider(provider.id as LinkableProviderId),
      disabled: isProviderLinkPending(provider.id as LinkableProviderId),
      visible:
        !isIntegrationsPending && provider.configured && !provider.linked,
    }),
  );

  const adminIntegrationCards: CardConfig[] = ADMIN_INTEGRATION_ORDER.map(
    (integrationId) => {
      const integration = getMcpIntegration(integrationId);
      const enabled =
        integrationId === 'linear'
          ? Boolean(status?.orgHasLinear)
          : enabledMcpIds.has(integrationId);
      const settingsId =
        integrationId === 'sentry' ? 'sentry-mcp' : integrationId;
      return {
        id: `enable-${integrationId}`,
        icon:
          integrationId === 'linear' ? (
            <LinearLogo className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <McpIcon icon={integration.icon} name={integration.name} />
          ),
        label: `Enable ${integration.name} for your workspace`,
        buttonLabel: 'Set it up',
        onClick: () =>
          router.push(`${SETTINGS_PATHS.integrations}?highlight=${settingsId}`),
        visible: isAdmin && !isIntegrationsPending && !enabled,
      };
    },
  );

  const personalMcpCards: CardConfig[] = PERSONAL_MCP_INTEGRATION_ORDER.map(
    (integrationId) => {
      const integration = getMcpIntegration(integrationId);
      const isConnected = authenticatedMcpIds.has(integrationId);
      const isPending =
        connectMcp.isPending && connectMcp.variables?.mcpId === integrationId;
      return {
        id: `link-${integrationId}`,
        icon: <McpIcon icon={integration.icon} name={integration.name} />,
        label: `Link your ${integration.name} account`,
        buttonLabel: 'Link',
        onClick: () => {
          connectMcp.mutate(
            { mcpId: integrationId, redirectTo: '/' },
            {
              onSuccess: (url) => {
                window.location.href = url;
              },
              onError: () =>
                toast.error(
                  `Failed to link ${integration.name}. Please try again.`,
                ),
            },
          );
        },
        disabled: isPending,
        visible:
          !isIntegrationsPending &&
          enabledMcpIds.has(integrationId) &&
          !isConnected,
      };
    },
  );

  const linearPersonalCard: CardConfig = {
    id: 'link-linear',
    icon: <LinearLogo className="size-4 shrink-0 text-muted-foreground" />,
    label: 'Link your Linear account',
    buttonLabel: 'Link',
    onClick: () =>
      authenticateLinearAccount.mutate('/', {
        onError: () => toast.error('Failed to link Linear. Please try again.'),
      }),
    disabled: authenticateLinearAccount.isPending,
    visible:
      !isIntegrationsPending &&
      Boolean(status?.orgHasLinear) &&
      !status?.userHasLinkedLinear,
  };

  const taskCards: CardConfig[] = [
    {
      id: 'automations',
      icon: (
        <Zap
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1}
        />
      ),
      label: "Put your team's work on autopilot with automations",
      buttonLabel: 'Go',
      onClick: () => router.push('/automations'),
      visible:
        !automationsPending &&
        Boolean(automationOnboardingStatus) &&
        !automationOnboardingStatus?.hasEnabledAutomations,
    },
    ...COMMUNICATION_PROVIDER_ORDER.flatMap((providerId) =>
      providerCards.filter((card) => card.id === `link-${providerId}`),
    ),
    ...SOURCE_CONTROL_PROVIDER_ORDER.flatMap((providerId) =>
      providerCards.filter((card) => card.id === `link-${providerId}`),
    ),
    ...adminIntegrationCards,
    ...personalMcpCards,
    linearPersonalCard,
  ];

  const ambientCards: CardConfig[] = [
    {
      id: 'cookbook',
      icon: <BookMarked className="size-4 shrink-0 text-muted-foreground" />,
      label: 'Explore recipes for common workflows',
      buttonLabel: 'Explore',
      href: DOCS_COOKBOOK_URL,
      external: true,
      visible: true,
    },
    {
      id: 'talk-to-us',
      icon: <Mail className="size-4 shrink-0 text-muted-foreground" />,
      label: 'Questions or ideas? We would love to hear from you',
      buttonLabel: 'Email us',
      href: 'mailto:help@roomote.dev',
      visible: true,
    },
  ];

  return (
    <>
      <div className="flex w-full items-center gap-2 px-4">
        {collapsed ? null : (
          <div className="grid min-w-0 grow grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
            <OnboardingLane
              cards={taskCards}
              dismissed={dismissed}
              onDismiss={dismiss}
              pending={isIntegrationsPending || automationsPending}
            />
            <OnboardingLane
              cards={ambientCards}
              dismissed={dismissed}
              onDismiss={dismiss}
            />
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand onboarding' : 'Collapse onboarding'}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      <Dialog
        open={linkDialog === 'telegram'}
        onOpenChange={(open) => !open && setLinkDialog(null)}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Link your Telegram account</DialogTitle>
            <DialogDescription>
              Connect your Telegram identity to Roomote.
            </DialogDescription>
          </DialogHeader>
          <TelegramLinkAccountStep autoGenerate pollUntilLinked />
        </DialogContent>
      </Dialog>
      <Dialog
        open={linkDialog === 'discord'}
        onOpenChange={(open) => !open && setLinkDialog(null)}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Link your Discord account</DialogTitle>
            <DialogDescription>
              Connect your Discord identity to Roomote.
            </DialogDescription>
          </DialogHeader>
          <DiscordLinkAccountStep autoGenerate pollUntilLinked />
        </DialogContent>
      </Dialog>
    </>
  );
}
