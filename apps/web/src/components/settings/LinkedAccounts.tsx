'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  isDeploymentScopedMcpIntegration,
  isSelfServeMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';

import {
  useAuthenticateGitHubAccount,
  useGitHubInstallations,
} from '@/hooks/github';
import {
  useAuthenticateLinearAccount,
  useLinearInstallation,
} from '@/hooks/linear';
import {
  useAdoLinkedAccount,
  useAuthenticateAdoAccount,
  useAuthenticateMicrosoftTeamsAccount,
  useAuthenticateGitLabAccount,
  useAuthenticateBitbucketAccount,
  useAuthenticateGiteaAccount,
  useCreateTelegramLinkCode,
  useGitLabLinkedAccount,
  useBitbucketLinkedAccount,
  useGiteaLinkedAccount,
  useGitHubLinkedAccount,
  useLinearLinkedAccount,
  useMicrosoftTeamsLinkedAccount,
  useSlackLinkedAccount,
  useTelegramLinkedAccount,
  useUnlinkAdoLinkedAccount,
  useUnlinkGitLabLinkedAccount,
  useUnlinkBitbucketLinkedAccount,
  useUnlinkGiteaLinkedAccount,
  useUnlinkGitHubLinkedAccount,
  useUnlinkLinearLinkedAccount,
  useUnlinkMicrosoftTeamsLinkedAccount,
  useUnlinkSlackLinkedAccount,
  useUnlinkTelegramLinkedAccount,
} from '@/hooks/linked-accounts';
import {
  useAuthenticateSlackAccount,
  useSlackInstallation,
} from '@/hooks/slack';
import {
  useConnectMcp,
  useDeploymentMcpEnablements,
  useDisconnectMcp,
  useUserMcpConnections,
} from '@/hooks/mcp-connections';
import { useAuthorizedUser } from '@/hooks/useUser';

import {
  BrandIcon,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Github,
  LinearLogo,
  LucideLink,
  Skeleton,
  Slack,
  Spinner,
  X,
} from '@/components/system';

import { McpIcon } from './McpIcon';
import { Section } from './Section';

type LinkedAccountRowProps = {
  icon: ReactNode;
  name: string;
  details?: ReactNode;
  actions?: ReactNode;
};

type LinkedAccountAction = {
  kind: 'link' | 'unlink';
  ariaLabel: string;
  isPending: boolean;
  onClick: () => void;
};

type LinkedAccountDescriptor = {
  key: string;
  name: string;
  priority: number;
  icon: ReactNode;
  details?: ReactNode;
  action?: LinkedAccountAction;
};

type RedirectLinkResult =
  | { success: true; url: string }
  | { success: false; error: string };

type UnlinkLinkedAccountResult =
  | { success: true }
  | { success: false; error: string };

type MutationCallbacks<TData> = {
  onSuccess?: (data: TData) => void;
  onError?: (error: unknown) => void;
};

type MutationLike<TData, TVariables> = {
  isPending: boolean;
  mutate: (variables: TVariables, options?: MutationCallbacks<TData>) => void;
};

type AuthClientLinkedAccountState = {
  configured: boolean;
  account: {
    accountId: string;
    displayName: string | null;
  } | null;
};

const LINKED_ACCOUNT_PRIORITY = {
  GitHub: 0,
  Slack: 1,
  Default: 2,
} as const;

function sortLinkedAccountDescriptors(
  left: LinkedAccountDescriptor,
  right: LinkedAccountDescriptor,
) {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  return left.name.localeCompare(right.name);
}

function isLinkedAccountDescriptor(
  descriptor: LinkedAccountDescriptor | null,
): descriptor is LinkedAccountDescriptor {
  return descriptor !== null;
}

function createLinkedAccountDescriptor({
  visible,
  key,
  name,
  icon,
  details,
  priority = LINKED_ACCOUNT_PRIORITY.Default,
  linkAction,
  unlinkAction,
}: {
  visible: boolean;
  key: string;
  name: string;
  icon: ReactNode;
  details?: ReactNode;
  priority?: number;
  linkAction?: Omit<LinkedAccountAction, 'kind'>;
  unlinkAction?: Omit<LinkedAccountAction, 'kind'>;
}): LinkedAccountDescriptor | null {
  if (!visible) {
    return null;
  }

  return {
    key,
    name,
    priority,
    icon,
    details,
    action: unlinkAction
      ? { kind: 'unlink', ...unlinkAction }
      : linkAction
        ? { kind: 'link', ...linkAction }
        : undefined,
  };
}

function startRedirectLink<TVariables>({
  mutation,
  variables,
  failureMessage,
}: {
  mutation: MutationLike<RedirectLinkResult, TVariables>;
  variables: TVariables;
  failureMessage: string;
}) {
  mutation.mutate(variables, {
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
        return;
      }

      toast.error(result.error);
    },
    onError: () => {
      toast.error(failureMessage);
    },
  });
}

function startInternalRedirectLink<TVariables>({
  mutation,
  variables,
  getErrorMessage,
}: {
  mutation: MutationLike<void, TVariables>;
  variables: TVariables;
  getErrorMessage: (error: unknown) => string;
}) {
  mutation.mutate(variables, {
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });
}

function startSimpleUnlink<TVariables, TData>({
  mutation,
  variables,
  successMessage,
  failureMessage,
}: {
  mutation: MutationLike<TData, TVariables>;
  variables: TVariables;
  successMessage: string;
  failureMessage: string;
}) {
  mutation.mutate(variables, {
    onSuccess: () => {
      toast.success(successMessage);
    },
    onError: () => {
      toast.error(failureMessage);
    },
  });
}

function startResultAwareUnlink<TVariables>({
  mutation,
  variables,
  successMessage,
  failureMessage,
}: {
  mutation: MutationLike<UnlinkLinkedAccountResult, TVariables>;
  variables: TVariables;
  successMessage: string;
  failureMessage: string;
}) {
  mutation.mutate(variables, {
    onSuccess: (result) => {
      if (result.success) {
        toast.success(successMessage);
        return;
      }

      toast.error(result.error);
    },
    onError: () => {
      toast.error(failureMessage);
    },
  });
}

function createAuthClientLinkedAccountDescriptor({
  key,
  name,
  icon,
  redirectTarget,
  state,
  authenticateAccount,
  unlinkAccount,
  fallbackDisplayName,
}: {
  key: string;
  name: string;
  icon: ReactNode;
  redirectTarget: string;
  state: AuthClientLinkedAccountState | undefined;
  authenticateAccount: MutationLike<void, string>;
  unlinkAccount: MutationLike<UnlinkLinkedAccountResult, string>;
  fallbackDisplayName: (accountId: string) => string;
}): LinkedAccountDescriptor | null {
  const account = state?.account ?? null;

  return createLinkedAccountDescriptor({
    visible: (state?.configured ?? false) || Boolean(account),
    key,
    name,
    icon,
    details: account ? (
      <span className="ph-no-capture">
        {account.displayName ?? fallbackDisplayName(account.accountId)}
      </span>
    ) : null,
    unlinkAction: account
      ? {
          ariaLabel: `Unlink ${name} account`,
          isPending: unlinkAccount.isPending,
          onClick: () => {
            startResultAwareUnlink({
              mutation: unlinkAccount,
              variables: account.accountId,
              successMessage: `${name} account unlinked.`,
              failureMessage: `Failed to unlink ${name} account. Please try again.`,
            });
          },
        }
      : undefined,
    linkAction: account
      ? undefined
      : {
          ariaLabel: `Link ${name} account`,
          isPending: authenticateAccount.isPending,
          onClick: () => {
            startInternalRedirectLink({
              mutation: authenticateAccount,
              variables: redirectTarget,
              getErrorMessage: (error) =>
                (error instanceof Error ? error.message : null) ||
                `Failed to link ${name} account. Please try again.`,
            });
          },
        },
  });
}

function LinkedAccountRow({
  icon,
  name,
  details,
  actions,
}: LinkedAccountRowProps) {
  return (
    <div className="flex gap-3 items-center justify-between py-1">
      <div className="flex items-center gap-3 overflow-hidden cursor-default">
        <div className="shrink-0 [&_svg]:size-5">{icon}</div>
        <span className="font-medium shrink-0">{name}</span>
        {details ? (
          <span className="text-muted-foreground truncate">{details}</span>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 [&_button]:w-24">{actions}</div>
      ) : null}
    </div>
  );
}

function LinkedAccountActionButton({
  action,
}: {
  action: LinkedAccountAction;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={action.onClick}
      disabled={action.isPending}
      aria-label={action.ariaLabel}
    >
      {action.isPending ? (
        <Spinner size="sm" />
      ) : action.kind === 'link' ? (
        <LucideLink />
      ) : (
        <X className="size-3" />
      )}
      {action.kind === 'link' ? 'Link' : 'Unlink'}
    </Button>
  );
}

function LinkedAccountRowSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-between gap-3 py-1"
    >
      <div className="flex items-center gap-3 overflow-hidden">
        <Skeleton className="size-5 shrink-0 rounded-md" />
        <Skeleton className="h-4 w-32 max-w-full" />
      </div>
      <Skeleton className="h-8 w-24 shrink-0" />
    </div>
  );
}

export function LinkedAccounts() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();

  const deploymentEnablements = useDeploymentMcpEnablements();
  const userConnections = useUserMcpConnections();
  const connectMcp = useConnectMcp();
  const disconnectMcp = useDisconnectMcp();

  const githubInstallations = useGitHubInstallations();
  const githubAccount = useGitHubLinkedAccount();
  const authenticateGitHubAccount = useAuthenticateGitHubAccount();
  const unlinkGitHubAccount = useUnlinkGitHubLinkedAccount();
  const gitlabAccount = useGitLabLinkedAccount();
  const authenticateGitLabAccount = useAuthenticateGitLabAccount();
  const unlinkGitLabAccount = useUnlinkGitLabLinkedAccount();
  const giteaAccount = useGiteaLinkedAccount();
  const authenticateGiteaAccount = useAuthenticateGiteaAccount();
  const unlinkGiteaAccount = useUnlinkGiteaLinkedAccount();
  const bitbucketAccount = useBitbucketLinkedAccount();
  const authenticateBitbucketAccount = useAuthenticateBitbucketAccount();
  const unlinkBitbucketAccount = useUnlinkBitbucketLinkedAccount();
  const adoAccount = useAdoLinkedAccount();
  const authenticateAdoAccount = useAuthenticateAdoAccount();
  const unlinkAdoAccount = useUnlinkAdoLinkedAccount();

  const slackInstallation = useSlackInstallation();
  const authenticateSlackAccount = useAuthenticateSlackAccount();
  const slackAccount = useSlackLinkedAccount();
  const unlinkSlackAccount = useUnlinkSlackLinkedAccount();

  const linearInstallation = useLinearInstallation();
  const authenticateLinearAccount = useAuthenticateLinearAccount();
  const linearAccount = useLinearLinkedAccount();
  const unlinkLinearAccount = useUnlinkLinearLinkedAccount();

  const microsoftTeamsAccount = useMicrosoftTeamsLinkedAccount();
  const authenticateMicrosoftTeamsAccount =
    useAuthenticateMicrosoftTeamsAccount();
  const unlinkMicrosoftTeamsAccount = useUnlinkMicrosoftTeamsLinkedAccount();

  const orgEnablementMap = useMemo(
    () =>
      new Map(
        (deploymentEnablements.data ?? []).map((entry) => [
          entry.mcpId,
          entry.enabled,
        ]),
      ),
    [deploymentEnablements.data],
  );
  const userConnectionMap = useMemo(
    () =>
      new Map(
        (userConnections.data ?? []).map((entry) => [entry.mcpId, entry]),
      ),
    [userConnections.data],
  );

  const userScopedEnabledMcpIntegrations = MCP_INTEGRATIONS.filter(
    (integration) =>
      isSelfServeMcpIntegration(integration) &&
      !isDeploymentScopedMcpIntegration(integration) &&
      (orgEnablementMap.get(integration.id) ?? false),
  );

  const search = searchParams.toString();
  const redirectTarget = search ? `${pathname}?${search}` : pathname;
  const linkedGitHubLogin = githubAccount.data?.githubLogin;
  const linkedSlackAccount = slackAccount.data;
  const linkedLinearAccount = linearAccount.data;
  const telegramAccount = useTelegramLinkedAccount();
  const createTelegramLinkCode = useCreateTelegramLinkCode();
  const unlinkTelegramAccount = useUnlinkTelegramLinkedAccount();
  const [telegramLinkCode, setTelegramLinkCode] = useState<{
    code: string;
    deepLink: string | null;
    expiresInSeconds: number;
  } | null>(null);
  const linkedTelegramAccount = telegramAccount.data?.mapping ?? null;

  const linkedAccountDescriptors = [
    createLinkedAccountDescriptor({
      visible: (githubInstallations.data?.length ?? 0) > 0,
      key: 'github',
      name: 'GitHub',
      priority: LINKED_ACCOUNT_PRIORITY.GitHub,
      icon: <Github className="size-4" />,
      details: linkedGitHubLogin ? (
        <span className="ph-no-capture">@{linkedGitHubLogin}</span>
      ) : null,
      unlinkAction: linkedGitHubLogin
        ? {
            ariaLabel: 'Unlink GitHub account',
            isPending: unlinkGitHubAccount.isPending,
            onClick: () => {
              startSimpleUnlink({
                mutation: unlinkGitHubAccount,
                variables: undefined,
                successMessage: `Unlinked @${linkedGitHubLogin}.`,
                failureMessage:
                  'Failed to unlink GitHub account. Please try again.',
              });
            },
          }
        : undefined,
      linkAction:
        linkedGitHubLogin || githubAccount.isPending
          ? undefined
          : {
              ariaLabel: 'Link GitHub account',
              isPending: authenticateGitHubAccount.isPending,
              onClick: () => {
                startRedirectLink({
                  mutation: authenticateGitHubAccount,
                  variables: {
                    redirect: redirectTarget,
                    callbackBackground: 'background',
                  },
                  failureMessage:
                    'Failed to link GitHub account. Please try again.',
                });
              },
            },
    }),
    createAuthClientLinkedAccountDescriptor({
      key: 'gitlab',
      name: 'GitLab',
      icon: <BrandIcon icon="gitlab" name="GitLab" className="size-4" />,
      redirectTarget,
      state: gitlabAccount.data,
      authenticateAccount: authenticateGitLabAccount,
      unlinkAccount: unlinkGitLabAccount,
      fallbackDisplayName: (accountId) => `GitLab user ${accountId}`,
    }),
    createAuthClientLinkedAccountDescriptor({
      key: 'gitea',
      name: 'Gitea',
      icon: <BrandIcon icon="gitea" name="Gitea" className="size-4" />,
      redirectTarget,
      state: giteaAccount.data,
      authenticateAccount: authenticateGiteaAccount,
      unlinkAccount: unlinkGiteaAccount,
      fallbackDisplayName: (accountId) => `Gitea user ${accountId}`,
    }),
    createAuthClientLinkedAccountDescriptor({
      key: 'bitbucket',
      name: 'Bitbucket',
      icon: <BrandIcon icon="bitbucket" name="Bitbucket" className="size-4" />,
      redirectTarget,
      state: bitbucketAccount.data,
      authenticateAccount: authenticateBitbucketAccount,
      unlinkAccount: unlinkBitbucketAccount,
      fallbackDisplayName: (accountId) => `Bitbucket user ${accountId}`,
    }),
    createAuthClientLinkedAccountDescriptor({
      key: 'ado',
      name: 'Azure DevOps',
      icon: <BrandIcon icon="ado" name="Azure DevOps" className="size-4" />,
      redirectTarget,
      state: adoAccount.data,
      authenticateAccount: authenticateAdoAccount,
      unlinkAccount: unlinkAdoAccount,
      fallbackDisplayName: (accountId) => `Azure DevOps user ${accountId}`,
    }),
    createLinkedAccountDescriptor({
      visible: Boolean(slackInstallation.data),
      key: 'slack',
      name: 'Slack',
      priority: LINKED_ACCOUNT_PRIORITY.Slack,
      icon: <Slack className="size-4" />,
      details: linkedSlackAccount ? (
        <span className="ph-no-capture">
          {linkedSlackAccount.teamName ?? linkedSlackAccount.slackUserId}
        </span>
      ) : null,
      unlinkAction: linkedSlackAccount
        ? {
            ariaLabel: 'Unlink Slack account',
            isPending: unlinkSlackAccount.isPending,
            onClick: () => {
              startResultAwareUnlink({
                mutation: unlinkSlackAccount,
                variables: undefined,
                successMessage: 'Slack account unlinked.',
                failureMessage:
                  'Failed to unlink Slack account. Please try again.',
              });
            },
          }
        : undefined,
      linkAction:
        linkedSlackAccount || slackAccount.isPending
          ? undefined
          : {
              ariaLabel: 'Link Slack account',
              isPending: authenticateSlackAccount.isPending,
              onClick: () => {
                startRedirectLink({
                  mutation: authenticateSlackAccount,
                  variables: pathname,
                  failureMessage:
                    'Failed to link Slack account. Please try again.',
                });
              },
            },
    }),
    createLinkedAccountDescriptor({
      visible: Boolean(telegramAccount.data?.configured),
      key: 'telegram',
      name: 'Telegram',
      icon: <BrandIcon icon="telegram" name="Telegram" className="size-4" />,
      details: linkedTelegramAccount ? (
        <span className="ph-no-capture">
          {linkedTelegramAccount.telegramUsername
            ? `@${linkedTelegramAccount.telegramUsername}`
            : linkedTelegramAccount.telegramUserId}
        </span>
      ) : null,
      unlinkAction: linkedTelegramAccount
        ? {
            ariaLabel: 'Unlink Telegram account',
            isPending: unlinkTelegramAccount.isPending,
            onClick: () => {
              startResultAwareUnlink({
                mutation: unlinkTelegramAccount,
                variables: undefined,
                successMessage: 'Telegram account unlinked.',
                failureMessage:
                  'Failed to unlink Telegram account. Please try again.',
              });
            },
          }
        : undefined,
      linkAction:
        linkedTelegramAccount || telegramAccount.isPending
          ? undefined
          : {
              ariaLabel: 'Link Telegram account',
              isPending: createTelegramLinkCode.isPending,
              onClick: () => {
                createTelegramLinkCode.mutate(undefined, {
                  onSuccess: (result) => {
                    setTelegramLinkCode(result);
                  },
                  onError: (error) => {
                    toast.error(
                      error.message ||
                        'Failed to create a Telegram link code. Please try again.',
                    );
                  },
                });
              },
            },
    }),
    createLinkedAccountDescriptor({
      visible: Boolean(linearInstallation.data),
      key: 'linear',
      name: 'Linear',
      icon: <LinearLogo className="size-4" />,
      details: linkedLinearAccount?.linearOrganizationName ? (
        <span className="ph-no-capture">
          {linkedLinearAccount.linearOrganizationName}
        </span>
      ) : null,
      unlinkAction: linkedLinearAccount
        ? {
            ariaLabel: 'Unlink Linear account',
            isPending: unlinkLinearAccount.isPending,
            onClick: () => {
              startResultAwareUnlink({
                mutation: unlinkLinearAccount,
                variables: undefined,
                successMessage: 'Linear account unlinked.',
                failureMessage:
                  'Failed to unlink Linear account. Please try again.',
              });
            },
          }
        : undefined,
      linkAction:
        linkedLinearAccount || linearAccount.isPending
          ? undefined
          : {
              ariaLabel: 'Link Linear account',
              isPending: authenticateLinearAccount.isPending,
              onClick: () => {
                startInternalRedirectLink({
                  mutation: authenticateLinearAccount,
                  variables: pathname,
                  getErrorMessage: () =>
                    'Failed to link Linear account. Please try again.',
                });
              },
            },
    }),
    createAuthClientLinkedAccountDescriptor({
      key: 'microsoft-teams',
      name: 'Microsoft Teams',
      icon: (
        <BrandIcon icon="teams" name="Microsoft Teams" className="size-4" />
      ),
      redirectTarget,
      state: microsoftTeamsAccount.data,
      authenticateAccount: authenticateMicrosoftTeamsAccount,
      unlinkAccount: unlinkMicrosoftTeamsAccount,
      fallbackDisplayName: (accountId) => `Microsoft user ${accountId}`,
    }),
    ...userScopedEnabledMcpIntegrations.map((integration) => {
      const connection = userConnectionMap.get(integration.id);
      const isLinked = connection?.authStatus === 'authenticated';
      const isConnectPending =
        connectMcp.isPending && connectMcp.variables?.mcpId === integration.id;
      const isDisconnectPending =
        disconnectMcp.isPending &&
        disconnectMcp.variables?.mcpId === integration.id;

      return createLinkedAccountDescriptor({
        visible: true,
        key: integration.id,
        name: integration.name,
        icon: <McpIcon icon={integration.icon} name={integration.name} />,
        details: isLinked ? 'Authorized via OAuth' : null,
        unlinkAction: isLinked
          ? {
              ariaLabel: `Unlink ${integration.name} account`,
              isPending: isDisconnectPending,
              onClick: () => {
                startSimpleUnlink({
                  mutation: disconnectMcp,
                  variables: { mcpId: integration.id },
                  successMessage: `${integration.name} account unlinked.`,
                  failureMessage: `Failed to unlink ${integration.name}. Please try again.`,
                });
              },
            }
          : undefined,
        linkAction: isLinked
          ? undefined
          : {
              ariaLabel: `Link ${integration.name} account`,
              isPending: isConnectPending,
              onClick: () => {
                connectMcp.mutate(
                  { mcpId: integration.id, redirectTo: pathname },
                  {
                    onSuccess: (url) => {
                      window.location.href = url;
                    },
                    onError: (error) => {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : `Failed to link ${integration.name}.`,
                      );
                    },
                  },
                );
              },
            },
      });
    }),
  ].filter(isLinkedAccountDescriptor);

  const hasVisibleRows = linkedAccountDescriptors.length > 0;
  const isLoadingVisibleRows =
    githubInstallations.isPending ||
    gitlabAccount.isPending ||
    giteaAccount.isPending ||
    adoAccount.isPending ||
    slackInstallation.isPending ||
    linearInstallation.isPending ||
    microsoftTeamsAccount.isPending ||
    deploymentEnablements.isPending ||
    userConnections.isPending;
  const showLoadingState = isLoadingVisibleRows && !hasVisibleRows;
  const emptyStateMessage = isAdmin
    ? 'No personal linked accounts are available yet. Enable a user-linked app in deployment integrations, then come back here to link your account.'
    : 'No personal linked accounts are available for this deployment yet. Ask an admin to enable a user-linked app in deployment integrations, then come back here to link your account.';

  return (
    <Section icon={LucideLink} title="Linked Accounts">
      {showLoadingState ? (
        <div className="space-y-1">
          <LinkedAccountRowSkeleton />
          <LinkedAccountRowSkeleton />
        </div>
      ) : null}

      {!showLoadingState && !hasVisibleRows ? (
        <p className="text-sm text-muted-foreground">{emptyStateMessage}</p>
      ) : null}

      {[...linkedAccountDescriptors]
        .sort(sortLinkedAccountDescriptors)
        .map((descriptor) => (
          <LinkedAccountRow
            key={descriptor.key}
            icon={descriptor.icon}
            name={descriptor.name}
            details={descriptor.details}
            actions={
              descriptor.action ? (
                <LinkedAccountActionButton action={descriptor.action} />
              ) : null
            }
          />
        ))}

      <Dialog
        open={telegramLinkCode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTelegramLinkCode(null);
            telegramAccount.refetch();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link your Telegram account</DialogTitle>
            <DialogDescription>
              Send this code to the Roomote bot within{' '}
              {Math.round((telegramLinkCode?.expiresInSeconds ?? 600) / 60)}{' '}
              minutes. Once the bot confirms, tasks you start from Telegram are
              attributed to you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <code className="block rounded-md bg-muted px-3 py-2 font-mono text-sm select-all ph-no-capture">
              {telegramLinkCode?.code}
            </code>
            {telegramLinkCode?.deepLink ? (
              <Button asChild variant="outline">
                <a
                  href={telegramLinkCode.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open the bot in Telegram
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Open your Roomote bot in Telegram and send the code as a
                message.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
