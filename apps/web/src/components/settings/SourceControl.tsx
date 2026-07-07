'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  prActions,
  sourceControlProviderDescriptors,
  sourceControlTokenBackedProviders,
  type PrAction,
  type SourceControlProvider,
  type SourceControlTokenBackedProvider,
} from '@roomote/types';

import {
  useEnableGitHubApp,
  useGitHubInstallations,
  useSyncGitHubInstallations,
} from '@/hooks/github';
import {
  usePrAction,
  useRepositories,
  useSetPrAction,
  useSourceControlConfigStatus,
  useSyncRepositories,
} from '@/hooks/source-control';
import { useAuthorizedUser } from '@/hooks/useUser';
import { getSourceControlSetupCopy } from '@/app/(onboarding)/setup/sourceControlSetupCopy';

import {
  Alert,
  AlertDescription,
  BrandIcon,
  BookMarked,
  Button,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitMerge,
  Pencil,
  Plug,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { Section } from '@/components/settings';
import { SourceControlConfigForm } from './SourceControlConfigForm';

const INITIAL_REPO_COUNT = 100;

type Repository = {
  id: string;
  fullName: string;
  htmlUrl: string;
};

type SourceControlProviderBlockProps = {
  provider: SourceControlProvider;
  title: string;
  isConnected: boolean;
  isConfigured: boolean;
  isPending: boolean;
  repositories?: Repository[];
  action?: ReactNode;
  connectedEmptyDescription: ReactNode;
  notConnectedDescription: ReactNode;
  repositoryTarget: string;
  adminHelp?: ReactNode;
  configForm?: ReactNode;
  onSetupClick?: () => void;
};

const TOKEN_PROVIDER_UI = {
  gitlab: {
    accessibleResource: 'projects',
    credentialName: 'deployment token',
    repositoryTarget: '_gitlab',
  },
  gitea: {
    accessibleResource: 'repositories',
    credentialName: 'deployment token',
    repositoryTarget: '_gitea',
  },
  ado: {
    accessibleResource: 'repositories',
    credentialName: 'PAT',
    repositoryTarget: '_ado',
  },
} satisfies Record<
  SourceControlTokenBackedProvider,
  {
    accessibleResource: string;
    credentialName: string;
    repositoryTarget: string;
  }
>;

type TokenProviderWebhookSummary =
  | {
      status: 'configured';
      created: number;
      updated: number;
      failed: { repositoryFullName: string; error?: string }[];
      skippedUnmapped?: number;
      removed?: number;
    }
  | { status: 'skipped'; reason: string };

type TokenProviderSyncResult =
  | {
      success: true;
      repositories: unknown[];
      webhooks?: TokenProviderWebhookSummary;
    }
  | { success: false; error: string };

type TokenProviderState = {
  repositories?: Repository[];
  isConnected: boolean;
  isConfigured: boolean;
  isPending: boolean;
  sync: {
    isPending: boolean;
    mutate: () => void;
  };
};

export function SourceControl() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();
  const highlighted = searchParams.get('highlight') === 'github';

  const gitHubInstallations = useGitHubInstallations();
  const sourceControlConfigStatus = useSourceControlConfigStatus();
  const gitHubRepositories = useRepositories({
    sourceControlProvider: 'github',
  });
  const gitLabRepositories = useRepositories({
    sourceControlProvider: 'gitlab',
  });
  const giteaRepositories = useRepositories({
    sourceControlProvider: 'gitea',
  });
  const adoRepositories = useRepositories({
    sourceControlProvider: 'ado',
  });

  const enableGitHubApp = useEnableGitHubApp();
  const syncGitHubInstallations = useSyncGitHubInstallations({
    onError: () => toast.error('Failed to refresh GitHub. Please try again.'),
  });
  const syncGitLabRepositories = useSyncRepositories('gitlab', {
    onSuccess: (result) => handleTokenProviderSyncSuccess('gitlab', result),
    onError: () =>
      toast.error(
        `Failed to refresh ${sourceControlProviderDescriptors.gitlab.label}. Please try again.`,
      ),
  });
  const syncGiteaRepositories = useSyncRepositories('gitea', {
    onSuccess: (result) => handleTokenProviderSyncSuccess('gitea', result),
    onError: () =>
      toast.error(
        `Failed to refresh ${sourceControlProviderDescriptors.gitea.label}. Please try again.`,
      ),
  });
  const syncAdoRepositories = useSyncRepositories('ado', {
    onSuccess: (result) => handleTokenProviderSyncSuccess('ado', result),
    onError: () =>
      toast.error(
        `Failed to refresh ${sourceControlProviderDescriptors.ado.label}. Please try again.`,
      ),
  });

  const gitHubIsPending =
    gitHubInstallations.isPending || gitHubRepositories.isPending;
  const gitHubIsConnected = (gitHubInstallations.data?.length ?? 0) > 0;
  const gitLabIsPending = gitLabRepositories.isPending;
  const gitLabIsConnected = (gitLabRepositories.data?.length ?? 0) > 0;
  const giteaIsPending = giteaRepositories.isPending;
  const giteaIsConnected = (giteaRepositories.data?.length ?? 0) > 0;
  const adoIsPending = adoRepositories.isPending;
  const adoIsConnected = (adoRepositories.data?.length ?? 0) > 0;
  const search = searchParams.toString();
  const redirectTarget = search ? `${pathname}?${search}` : pathname;

  const tokenProviderState = {
    gitlab: {
      repositories: gitLabRepositories.data,
      isConnected: gitLabIsConnected,
      isConfigured: isProviderConfigured(
        sourceControlConfigStatus.data,
        'gitlab',
      ),
      isPending: gitLabIsPending,
      sync: syncGitLabRepositories,
    },
    gitea: {
      repositories: giteaRepositories.data,
      isConnected: giteaIsConnected,
      isConfigured: isProviderConfigured(
        sourceControlConfigStatus.data,
        'gitea',
      ),
      isPending: giteaIsPending,
      sync: syncGiteaRepositories,
    },
    ado: {
      repositories: adoRepositories.data,
      isConnected: adoIsConnected,
      isConfigured: isProviderConfigured(sourceControlConfigStatus.data, 'ado'),
      isPending: adoIsPending,
      sync: syncAdoRepositories,
    },
  } satisfies Record<SourceControlTokenBackedProvider, TokenProviderState>;

  const [configuringProvider, setConfiguringProvider] =
    useState<SourceControlTokenBackedProvider | null>(null);

  const providerBlocks: SourceControlProviderBlockProps[] = [
    {
      provider: 'github',
      title: sourceControlProviderDescriptors.github.label,
      isConnected: gitHubIsConnected,
      isConfigured: gitHubIsConnected,
      isPending: gitHubIsPending,
      repositories: gitHubRepositories.data,
      repositoryTarget: '_github',
      action:
        !gitHubIsPending && isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                enableGitHubApp.mutate(
                  {
                    redirect: redirectTarget,
                    callbackBackground: 'background',
                  },
                  {
                    onSuccess: (result) => {
                      if (!result.success) {
                        toast.error(result.error);
                        return;
                      }

                      if (result.mode === 'redirect') {
                        window.location.href = result.url;
                        return;
                      }

                      toast.success('GitHub re-enabled for this deployment.');
                    },
                    onError: () =>
                      toast.error(
                        'Failed to connect GitHub. Please try again.',
                      ),
                  },
                );
              }}
              disabled={enableGitHubApp.isPending}
            >
              {gitHubIsConnected ? <Pencil /> : <Plug />}
              {gitHubIsConnected ? 'Update GitHub' : 'Connect GitHub'}
            </Button>
            {gitHubIsConnected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => syncGitHubInstallations.mutate()}
                disabled={syncGitHubInstallations.isPending}
              >
                <RefreshCw
                  className={
                    syncGitHubInstallations.isPending
                      ? 'animate-spin'
                      : undefined
                  }
                />
                Refresh GitHub
              </Button>
            ) : null}
          </div>
        ) : null,
      connectedEmptyDescription: (
        <>
          Your GitHub integration is connected but there are no available
          repositories yet. Click{' '}
          <span className="font-semibold">Update GitHub</span> to select one or
          more repositories.
        </>
      ),
      notConnectedDescription: (
        <>
          Connect the Roomote GitHub app to make repositories available to this
          deployment.
        </>
      ),
      adminHelp: isAdmin
        ? 'Missing a repo here? Update GitHub, then refresh to make it available here.'
        : undefined,
    },
    ...sourceControlTokenBackedProviders.map((provider) =>
      buildTokenProviderBlock({
        provider,
        isAdmin,
        state: tokenProviderState[provider],
        onConfigure: () => setConfiguringProvider(provider),
        configForm:
          tokenProviderState[provider].isConfigured ||
          configuringProvider === provider ? (
            <SourceControlConfigForm
              provider={provider}
              configStatus={sourceControlConfigStatus.data}
              saveSuccessMessage={`${sourceControlProviderDescriptors[provider].label} credentials saved.`}
              onSaved={() => tokenProviderState[provider].sync.mutate()}
            />
          ) : null,
      }),
    ),
  ];

  return (
    <div id="source-control" className="space-y-4">
      {highlighted ? (
        <Alert>
          <AlertDescription>
            Continue with <strong>GitHub</strong> here. This section is the
            target for the setup recommendation link.
          </AlertDescription>
        </Alert>
      ) : null}
      <Section icon={GitMerge} title="Source Control Settings">
        <div className="space-y-4">{isAdmin ? <PrActionSetting /> : null}</div>
      </Section>
      {providerBlocks.map((providerBlock) => (
        <SourceControlProviderBlock
          key={providerBlock.provider}
          {...providerBlock}
        />
      ))}
    </div>
  );
}

const PR_ACTION_LABELS: Record<PrAction, string> = {
  draft: 'Draft pull request',
  create: 'Ready-for-review pull request',
  push: 'Push branch only (no pull request)',
};

/**
 * Deployment-wide default for how repository-changing tasks deliver their
 * work, mirroring the upstream Coder agent `prAction` setting.
 */
function PrActionSetting() {
  const prActionQuery = usePrAction();
  const setPrAction = useSetPrAction();
  const currentPrAction = prActionQuery.data?.prAction ?? 'draft';

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium">Pull request delivery</div>
        <p className="text-sm text-muted-foreground">
          How tasks deliver repository changes by default. Users can ask for
          something else in the task itself.
        </p>
      </div>
      <Select
        value={currentPrAction}
        onValueChange={(value) => {
          setPrAction.mutate(value as PrAction, {
            onSuccess: () => toast.success('Source control settings saved.'),
            onError: (error) =>
              toast.error(`Failed to update PR delivery: ${error.message}`),
          });
        }}
        disabled={prActionQuery.isLoading || setPrAction.isPending}
      >
        <SelectTrigger className="w-full max-w-sm">
          <SelectValue placeholder="Select a delivery mode" />
        </SelectTrigger>
        <SelectContent>
          {prActions.map((action) => (
            <SelectItem key={action} value={action}>
              {PR_ACTION_LABELS[action]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function buildTokenProviderBlock({
  provider,
  isAdmin,
  state,
  onConfigure,
  configForm,
}: {
  provider: SourceControlTokenBackedProvider;
  isAdmin: boolean;
  state: TokenProviderState;
  onConfigure: () => void;
  configForm?: ReactNode;
}): SourceControlProviderBlockProps {
  const { label } = sourceControlProviderDescriptors[provider];
  const ui = TOKEN_PROVIDER_UI[provider];

  return {
    provider,
    title: label,
    isConnected: state.isConnected,
    isConfigured: state.isConfigured,
    isPending: state.isPending,
    repositories: state.repositories,
    repositoryTarget: ui.repositoryTarget,
    action:
      !state.isPending && isAdmin && state.isConfigured ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => state.sync.mutate()}
            disabled={state.sync.isPending}
          >
            <RefreshCw
              className={state.sync.isPending ? 'animate-spin' : undefined}
            />
            {`Refresh ${label}`}
          </Button>
        </div>
      ) : null,
    connectedEmptyDescription: (
      <>
        {label} is connected but no active repositories are available yet.
        Refresh {label} after confirming the {ui.credentialName} can see the
        expected {ui.accessibleResource}.
      </>
    ),
    notConnectedDescription: (
      <>
        Configure {label} credentials, then sync to make repositories available
        to this deployment.
      </>
    ),
    configForm,
    onSetupClick: onConfigure,
    adminHelp: isAdmin
      ? `Missing a repo here? Confirm the ${label} ${ui.credentialName} can access it, then refresh ${label}.`
      : undefined,
  };
}

function handleTokenProviderSyncSuccess(
  provider: SourceControlTokenBackedProvider,
  result: TokenProviderSyncResult,
) {
  if (!result.success) {
    toast.error(result.error);
    return;
  }

  const label = sourceControlProviderDescriptors[provider].label;

  toast.success(
    `Synced ${result.repositories.length} ${label} ${
      result.repositories.length === 1 ? 'repository' : 'repositories'
    }.`,
  );

  const webhooks = result.webhooks;

  if (!webhooks) {
    return;
  }

  if (webhooks.status === 'skipped') {
    toast.info(`${label} webhooks were not configured: ${webhooks.reason}`);
    return;
  }

  const configuredCount = webhooks.created + webhooks.updated;
  const webhookSubject =
    provider === 'gitlab'
      ? 'merge request webhooks'
      : provider === 'ado'
        ? 'Azure DevOps service hooks'
        : 'pull request webhooks';
  const webhookResource = provider === 'gitlab' ? 'project' : 'repository';
  const webhookRole =
    provider === 'gitlab'
      ? 'the Maintainer role'
      : provider === 'ado'
        ? 'permission to manage service hook subscriptions'
        : 'repository admin access';

  if (webhooks.failed.length > 0) {
    toast.warning(
      `Configured ${webhookSubject} on ${configuredCount} ${
        configuredCount === 1 ? webhookResource : `${webhookResource}s`
      }, but ${webhooks.failed.length} failed (the token identity may need ${webhookRole}): ${webhooks.failed
        .map((failure) => failure.repositoryFullName)
        .join(', ')}`,
    );
  } else if (configuredCount > 0) {
    toast.success(
      `${webhookSubject[0]?.toUpperCase()}${webhookSubject.slice(
        1,
      )} are configured on ${configuredCount} ${
        configuredCount === 1 ? webhookResource : `${webhookResource}s`
      }.`,
    );
  }

  const skippedUnmapped = webhooks.skippedUnmapped ?? 0;
  const removed = webhooks.removed ?? 0;

  if (skippedUnmapped > 0 || removed > 0) {
    const skippedPart =
      skippedUnmapped > 0
        ? `${skippedUnmapped} synced ${
            skippedUnmapped === 1
              ? `${webhookResource} has`
              : `${webhookResource}s have`
          } no environment mapping, so ${webhookSubject} were not created there`
        : '';
    const removedPart =
      removed > 0
        ? `${removed} previously created ${
            removed === 1 ? 'webhook was' : 'webhooks were'
          } removed from unmapped ${webhookResource}s`
        : '';

    toast.info(
      `${[skippedPart, removedPart]
        .filter(Boolean)
        .join(
          ', and ',
        )}. Map a repository to an environment and re-run sync to configure its ${webhookSubject}.`,
    );
  }
}

function SourceControlProviderBlock({
  provider,
  title,
  isConnected,
  isConfigured,
  isPending,
  repositories,
  action,
  connectedEmptyDescription,
  notConnectedDescription,
  repositoryTarget,
  adminHelp,
  configForm,
  onSetupClick,
}: SourceControlProviderBlockProps) {
  const [isRepositoryListOpen, setIsRepositoryListOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(isConfigured);
  const repositoryCount = repositories?.length ?? 0;
  const shouldShowSetup = !isPending && !isConfigured && !isExpanded;

  useEffect(() => {
    if (isConfigured) {
      setIsExpanded(true);
    }
  }, [isConfigured]);

  return (
    <Section
      icon={
        <BrandIcon icon={provider} name={title} className="size-4 shrink-0" />
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span>{title}</span>
          {isConnected && repositoryCount > 0 ? (
            <span className="text-muted-foreground">
              {repositoryCount} repos
            </span>
          ) : null}
        </span>
      }
      action={shouldShowSetup ? null : action}
    >
      {shouldShowSetup ? (
        <p className="text-sm text-muted-foreground">
          Not configured.{' '}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-4 hover:text-accent-foreground"
            onClick={() => {
              setIsExpanded(true);
              onSetupClick?.();
            }}
          >
            Set it up
          </button>
        </p>
      ) : (
        <div className="space-y-8">
          {!isConfigured ? (
            <ProviderSetupInstructions provider={provider} title={title} />
          ) : null}
          {configForm}
          {isPending ? null : repositoryCount > 0 && repositories ? (
            <div>
              <RepositoryLinks
                repositories={repositories}
                isOpen={isRepositoryListOpen}
                target={repositoryTarget}
              />
              {repositoryCount > INITIAL_REPO_COUNT ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="mt-1"
                  onClick={() => setIsRepositoryListOpen((current) => !current)}
                >
                  {isRepositoryListOpen ? (
                    <>
                      <ChevronUp />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown />
                      Show {repositoryCount - INITIAL_REPO_COUNT} more
                    </>
                  )}
                </Button>
              ) : null}
              {adminHelp ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {adminHelp}
                </p>
              ) : null}
            </div>
          ) : isConnected ? (
            <p className="text-sm text-muted-foreground">
              {connectedEmptyDescription}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {notConnectedDescription}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function ProviderSetupInstructions({
  provider,
  title,
}: {
  provider: SourceControlProvider;
  title: string;
}) {
  const setupCopy = getSourceControlSetupCopy(provider);
  const credentialStep =
    provider === 'github'
      ? 'Install the app for the repositories Roomote should work with. Roomote uses the installation to sync repositories and receive pull request events.'
      : 'Copy the generated credential, then paste it below. Roomote stores deployment credentials securely and uses them to sync repositories and configure pull request webhooks.';

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-semibold">
          Create a{' '}
          <a
            href={setupCopy.creationHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {setupCopy.setupLabel}
            <ExternalLink className="ml-1 inline size-4 -translate-y-0.5" />
          </a>{' '}
          for {title}.
        </p>
        <p className="text-sm text-muted-foreground">
          {setupCopy.creationHint ??
            'Roomote will guide you through GitHub app creation and installation, then bring the selected repositories back here.'}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">
          Copy credentials and finish setup.
        </p>
        <p className="text-sm text-muted-foreground">{credentialStep}</p>
      </div>
    </div>
  );
}

function isProviderConfigured(
  configStatus: ReturnType<typeof useSourceControlConfigStatus>['data'],
  provider: SourceControlTokenBackedProvider,
) {
  const providerStatus = configStatus?.providers.find(
    (candidate) => candidate.provider === provider,
  );

  return (
    providerStatus?.fields.some(
      (field) => field.runtimeSatisfied || field.savedSatisfied,
    ) ?? false
  );
}

function RepositoryLinks({
  repositories,
  isOpen,
  target,
}: {
  repositories: Repository[];
  isOpen: boolean;
  target: string;
}) {
  const visibleRepositories = isOpen
    ? repositories
    : repositories.slice(0, INITIAL_REPO_COUNT);

  return (
    <ul className="grid gap-1 space-y-1 space-x-4 py-2 text-sm md:grid-cols-2">
      {visibleRepositories.map((repo) => (
        <li key={repo.id}>
          <Link
            href={repo.htmlUrl}
            target={target}
            className="flex items-start gap-2 hover:text-foreground"
          >
            <BookMarked className="mt-1 size-3" />
            <span className="ph-no-capture">{repo.fullName}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
