'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH,
  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER,
  PRODUCT_NAME,
} from '@roomote/types';

import { useCreateGitHubInstallation } from '@/hooks/github';
import { useRepositories } from '@/hooks/source-control';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { DOCS_ENVIRONMENT_DEFINITION_URL } from '@/lib/docs';
import {
  areAllRepositoriesEmpty,
  getEmptyRepositories,
} from '@/lib/repositories';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

import {
  Alert,
  AlertDescription,
  AlertTriangle,
  ArrowRight,
  Button,
  Card,
  CardContent,
  Github,
  Input,
  Loader2,
  RefreshCcw,
  RotateCw,
  Search,
  Spinner,
  Textarea,
  X,
} from '@/components/system';
import { EnvironmentRepositorySelector } from '@/components/settings/environments/EnvironmentRepositorySelector';
import { ModelSelect } from '@/components/tasks';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const REPO_SELECTION_STEP = getSetupStepDefinition('repo-selection');

export type SetupRetryReason =
  | 'task-failed'
  | 'task-canceled'
  | 'no-environment';

const SETUP_GUIDANCE_WARNING_THRESHOLD = 7_500;
type SetupRepository = {
  id: string;
  fullName: string;
  isEmpty?: boolean | null;
};

function getRetryCopy(reason: SetupRetryReason): string {
  switch (reason) {
    case 'task-canceled':
      return 'Roomote kept your previous repo selection below. Review it, make any changes you need, and continue to start setup again.';
    case 'no-environment':
      return 'The previous setup run finished, but it did not produce a working environment for these repos. Review the selection and guidance below, then continue to try again.';
    case 'task-failed':
    default:
      return 'Roomote could not finish creating your first environment from the previous setup run. Review the repos and guidance below, then continue to try again.';
  }
}

export function StepRepoSelection({
  onContinue,
  onSkip,
  onReviewComputeProvider,
  initialSelectedRepositoryIds = [],
  initialSetupGuidance = '',
  initialSelectedModelId = null,
  retryReason = null,
}: {
  onContinue: () => void;
  onSkip: () => void;
  onReviewComputeProvider?: () => void;
  initialSelectedRepositoryIds?: string[];
  initialSetupGuidance?: string;
  initialSelectedModelId?: string | null;
  retryReason?: SetupRetryReason | null;
}) {
  const pathname = usePathname();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const repositories = useRepositories({ includeEmptyState: true });
  const launchTaskModels = useLaunchTaskModels();
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>(
    initialSelectedRepositoryIds,
  );
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(
    initialSelectedModelId ?? undefined,
  );
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [setupGuidance, setSetupGuidance] = useState(initialSetupGuidance);
  const [isRefreshPending, setIsRefreshPending] = useState(false);
  const refreshPromiseRef = useRef<Promise<unknown> | null>(null);
  const hasAutoSelectedSingleRepoRef = useRef(
    initialSelectedRepositoryIds.length > 0,
  );

  const saveSelection = useMutation(
    trpc.setupNew.saveSelection.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        onContinue();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const connectGitHub = useCreateGitHubInstallation({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.url;
      } else {
        toast.error(result.error);
      }
    },
    onError: () => toast.error('Failed to connect GitHub. Please try again.'),
  });

  const sortedRepositories = useMemo<SetupRepository[]>(
    () =>
      (repositories.data ?? []).map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        isEmpty: (repository as SetupRepository).isEmpty,
      })),
    [repositories.data],
  );
  const showRepositoryFilter = sortedRepositories.length > 5;

  useEffect(() => {
    if (hasAutoSelectedSingleRepoRef.current) {
      return;
    }

    if (repositories.isPending || repositories.data === undefined) {
      return;
    }

    if (selectedRepositoryIds.length > 0) {
      hasAutoSelectedSingleRepoRef.current = true;
      return;
    }

    if (sortedRepositories.length !== 1) {
      return;
    }

    hasAutoSelectedSingleRepoRef.current = true;
    setSelectedRepositoryIds([sortedRepositories[0]!.id]);
  }, [
    repositories.data,
    repositories.isPending,
    selectedRepositoryIds.length,
    sortedRepositories,
  ]);

  useEffect(() => {
    if (!showRepositoryFilter && repositoryFilter) {
      setRepositoryFilter('');
    }
  }, [repositoryFilter, showRepositoryFilter]);

  const filteredRepositories = useMemo(() => {
    if (!showRepositoryFilter) {
      return sortedRepositories;
    }

    const normalizedFilter = repositoryFilter.trim().toLowerCase();

    if (!normalizedFilter) {
      return sortedRepositories;
    }

    return sortedRepositories.filter((repository) =>
      repository.fullName.toLowerCase().includes(normalizedFilter),
    );
  }, [repositoryFilter, showRepositoryFilter, sortedRepositories]);

  const selectedRepositories = useMemo(() => {
    if (selectedRepositoryIds.length === 0) {
      return [];
    }

    const selectedRepositoryIdSet = new Set(selectedRepositoryIds);

    return sortedRepositories.filter((repository) =>
      selectedRepositoryIdSet.has(repository.id),
    );
  }, [selectedRepositoryIds, sortedRepositories]);
  const selectedEmptyRepositories = useMemo(() => {
    if (selectedRepositories.length === 0) {
      return [];
    }

    return getEmptyRepositories(selectedRepositories);
  }, [selectedRepositories]);
  const allSelectedRepositoriesAreEmpty = useMemo(
    () => areAllRepositoriesEmpty(selectedRepositories),
    [selectedRepositories],
  );

  const toggleRepository = useCallback((repositoryId: string) => {
    setSelectedRepositoryIds((currentSelection) =>
      currentSelection.includes(repositoryId)
        ? currentSelection.filter((currentId) => currentId !== repositoryId)
        : [...currentSelection, repositoryId],
    );
  }, []);

  const handleManageGitHubAccess = useCallback(() => {
    connectGitHub.mutate(`${pathname}?step=repo-selection`);
  }, [connectGitHub, pathname]);

  const refreshRepositories = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return;
    }

    setIsRefreshPending(true);
    const refreshPromise = Promise.resolve(repositories.refetch());
    refreshPromiseRef.current = refreshPromise;

    try {
      await refreshPromise;
    } finally {
      if (refreshPromiseRef.current === refreshPromise) {
        refreshPromiseRef.current = null;
      }
      setIsRefreshPending(false);
    }
  }, [repositories]);

  const effectiveSelectedModelId =
    selectedModelId ?? launchTaskModels.data?.defaultModelId;

  const handleContinue = useCallback(async () => {
    if (selectedRepositoryIds.length === 0) {
      return;
    }

    await saveSelection.mutateAsync({
      repositoryIds: selectedRepositoryIds,
      setupGuidance: setupGuidance.trim() || undefined,
      ...(effectiveSelectedModelId
        ? { selectedModelId: effectiveSelectedModelId }
        : {}),
    });
  }, [
    effectiveSelectedModelId,
    saveSelection,
    selectedRepositoryIds,
    setupGuidance,
  ]);

  const isBusy = saveSelection.isPending;
  const isRefreshingRepositories = repositories.isFetching || isRefreshPending;

  if (repositories.isPending) {
    return <Spinner />;
  }

  if (sortedRepositories.length === 0) {
    return (
      <div className="relative w-full max-w-3xl space-y-6 py-2 md:py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <StepTitle text={REPO_SELECTION_STEP.title} />
        </div>
        <div className="space-y-2">
          <p className="font-semibold">No repositories available yet.</p>
          <p>
            {PRODUCT_NAME} is connected to GitHub, but this deployment does not
            currently have any accessible repositories to use for setup.
          </p>
          <div className="flex flex-col md:flex-row gap-2 items-center mt-6">
            <Button
              type="button"
              variant="default"
              className="w-full md:w-auto"
              onClick={() => void refreshRepositories()}
              disabled={isRefreshingRepositories}
            >
              {isRefreshingRepositories ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCcw />
              )}
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full md:w-auto"
              onClick={handleManageGitHubAccess}
              disabled={connectGitHub.isPending}
            >
              {connectGitHub.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Github />
              )}
              Edit GitHub Access
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full md:w-auto"
              onClick={onSkip}
            >
              Skip
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Not recommended</p>
        </div>
      </div>
    );
  }

  const showForm = selectedRepositoryIds.length > 0;
  const retryCopy = retryReason ? getRetryCopy(retryReason) : null;
  const setupGuidanceLength = setupGuidance.length;
  const charCounter = `${setupGuidanceLength.toLocaleString()}/${ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH.toLocaleString()}`;
  const emptyRepositoryWarningCopy =
    selectedEmptyRepositories.length === 1
      ? 'The selected repository has no commits yet.'
      : 'All selected repositories have no commits yet.';
  const selectedEmptyRepositoryNames = selectedEmptyRepositories
    .map((repository) => repository.fullName)
    .join(', ');

  return (
    <div className="relative w-full max-w-4xl space-y-6 py-2 md:py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <StepTitle text={REPO_SELECTION_STEP.title} />
      </div>
      <div className="space-y-3 text-sm text-foreground">
        {!showForm && (
          <p>
            <span className="font-semibold">
              {PRODUCT_NAME} excels by verifying its work.
            </span>{' '}
            To do that, it needs to run your app locally, click around, take
            screenshots. So we need to configure an environment, which includes
            any required repos, dependencies, and related setup.{' '}
            <a
              href={DOCS_ENVIRONMENT_DEFINITION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-4"
            >
              See docs
            </a>
            .
          </p>
        )}
        <p className="font-semibold text-foreground">
          Pick the repo(s) needed for the very first environment you want to set
          up.
        </p>
      </div>

      {retryCopy ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            {/* Single child: AlertDescription lays out its children with
                flex, which would split loose text and the button apart. */}
            <p>
              {retryCopy}
              {retryReason === 'task-failed' && onReviewComputeProvider ? (
                <>
                  {' '}
                  If the run failed before doing any work, you can also{' '}
                  <button
                    type="button"
                    className="underline underline-offset-4"
                    onClick={onReviewComputeProvider}
                  >
                    review your sandbox provider
                  </button>
                  .
                </>
              ) : null}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="p-3">
        <CardContent>
          <div className="space-y-3">
            {showRepositoryFilter ? (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={repositoryFilter}
                  onChange={(event) =>
                    setRepositoryFilter(event.currentTarget.value)
                  }
                  placeholder="Filter repositories"
                  aria-label="Filter repositories"
                  className="pr-9 pl-9"
                />
                {repositoryFilter ? (
                  <button
                    type="button"
                    onClick={() => setRepositoryFilter('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    aria-label="Clear repository filter"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}

            {filteredRepositories.length > 0 ? (
              <EnvironmentRepositorySelector
                repositories={filteredRepositories}
                selectedRepositoryIds={selectedRepositoryIds}
                onToggleRepository={toggleRepository}
                inputPrefix="setup-repository"
                heightClassName="max-h-[calc(var(--effective-viewport-height)-40rem)] md:h-[18.75rem]"
              />
            ) : (
              <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
                No repositories match that filter.
              </div>
            )}
          </div>
          {allSelectedRepositoriesAreEmpty ? (
            <Alert variant="warning">
              <AlertTriangle className="size-4" />
              <AlertDescription className="flex-col items-start gap-1">
                <p>
                  {emptyRepositoryWarningCopy} Push an initial commit before
                  continuing, or choose different repositories.
                </p>
                <p className="font-medium text-foreground">
                  {selectedEmptyRepositoryNames}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshRepositories()}
                  disabled={connectGitHub.isPending || isRefreshingRepositories}
                >
                  {isRefreshingRepositories ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RotateCw />
                  )}
                  Refresh list
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {showForm ? (
            <div className="space-y-2 flex flex-col items-start">
              <Textarea
                value={setupGuidance}
                onChange={(event) => setSetupGuidance(event.target.value)}
                placeholder={ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER}
                maxLength={ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH}
                disabled={isBusy}
                className="h-20 min-h-20 resize-none"
              />
              <p
                className={cn(
                  'text-muted-foreground self-stretch text-right text-xs',
                  setupGuidanceLength > SETUP_GUIDANCE_WARNING_THRESHOLD &&
                    'text-warning-foreground',
                )}
              >
                {setupGuidanceLength >
                  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH * 0.8 &&
                  charCounter}
              </p>
              <div className="flex w-full flex-wrap items-center gap-3">
                <ModelSelect
                  value={effectiveSelectedModelId}
                  onValueChange={setSelectedModelId}
                  disabled={isBusy}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleContinue()}
                  disabled={isBusy || allSelectedRepositoriesAreEmpty}
                >
                  {isBusy && <Loader2 className="animate-spin" />}
                  Continue
                  <ArrowRight />
                </Button>
                <p className="text-sm text-muted-foreground ml-auto">
                  Or, if you must,
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="p-0! -ml-1"
                  onClick={onSkip}
                >
                  do this later
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {!showForm ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refreshRepositories()}
            disabled={connectGitHub.isPending || isRefreshingRepositories}
          >
            {isRefreshingRepositories ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Refresh list
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleManageGitHubAccess}
            disabled={connectGitHub.isPending}
          >
            {connectGitHub.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Github />
            )}
            Edit GitHub Access
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onSkip}>
            Skip
          </Button>
          <p className="self-center text-sm text-muted-foreground">
            Not recommended
          </p>
        </div>
      ) : null}
    </div>
  );
}
