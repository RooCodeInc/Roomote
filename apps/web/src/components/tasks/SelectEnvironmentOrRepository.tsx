import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  Settings,
  Plus,
  Trash2,
  BookMarked,
  BookCopy,
  ChevronsUpDown,
  SquareDashed,
  Zap,
  Check,
  VectorSquare,
} from '@/components/system';

import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  NO_REPOSITORIES,
} from '@roomote/types';

import type { CreateTaskFormValues } from '@/types';

import { cn } from '@/lib/utils';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';

import {
  useAvailableEnvironments,
  useEnvironments,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useWorkspaceStorage } from '@/hooks/useWorkspaceStorage';

import {
  FormControl,
  FormField,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Button,
  InfoTooltip,
} from '@/components/system';
import { AUTO_WORKSPACE_VALUE } from './constants';

const CREATE_NEW = '__create__';
const ENV_PREFIX = 'env:';
const REPO_PREFIX = 'repo:';

interface SelectEnvironmentOrRepositoryProps {
  repositoryFilter?: string;
  lockedBranch?: string;
  allowAuto?: boolean;
  allowFast?: boolean;
  autoSelectDefaultWorkspace?: boolean;
  onInvalidWorkspaceReset?: () => void;
  onCreate: () => void;
  onCreateRepository?: () => void;
  onEdit: (e: React.MouseEvent, envId: string) => void;
  onDelete: (e: React.MouseEvent, env: EnvironmentWithMeta) => void;
}

export const SelectEnvironmentOrRepository = ({
  repositoryFilter,
  lockedBranch,
  allowAuto = false,
  allowFast = false,
  autoSelectDefaultWorkspace = true,
  onInvalidWorkspaceReset,
  onCreate,
  onCreateRepository,
  onEdit,
  onDelete,
}: SelectEnvironmentOrRepositoryProps) => {
  const { control, watch, setValue } = useFormContext<CreateTaskFormValues>();
  const environmentId = watch('environmentId');
  const repository = watch('repository');

  const { isAdmin } = useAuthorizedUser();
  const { setWorkspace } = useWorkspaceStorage();
  const [hasAppliedDefaultWorkspace, setHasAppliedDefaultWorkspace] =
    useState(false);
  // Tracks menu choices only so programmatic form resets (e.g. Home workspace
  // restoration writing Auto after this selector defaults the sole env) can
  // re-apply the sole-environment default.
  const hasUserSelectedWorkspaceRef = useRef(false);

  const fullEnvironments = useEnvironments({ enabled: isAdmin });
  const availableEnvironments = useAvailableEnvironments(repositoryFilter);
  // Members only receive the minimal availability shape; management controls
  // below remain admin-only.
  const environments = isAdmin
    ? fullEnvironments
    : (availableEnvironments as typeof fullEnvironments);
  const repositories = useRepositories();
  const allRepositories = useMemo(
    () =>
      repositoryFilter
        ? (repositories.data ?? []).filter(
            ({ fullName }) => fullName === repositoryFilter,
          )
        : (repositories.data ?? []),
    [repositories.data, repositoryFilter],
  );

  const sortedEnvironments = useMemo(
    () =>
      environments.data
        ? [...environments.data]
            .filter((env) =>
              repositoryFilter && isAdmin
                ? (env.config?.repositories?.some(
                    (repo) => repo.repository === repositoryFilter,
                  ) ?? false)
                : true,
            )
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [environments.data, isAdmin, repositoryFilter],
  );

  const selectedEnv = environments.data?.find(
    (env) => env.id === environmentId,
  );

  useEffect(() => {
    if (
      !autoSelectDefaultWorkspace ||
      environments.isPending ||
      !environments.isSuccess
    ) {
      return;
    }

    const canRetrySoleDefaultAfterReset =
      hasAppliedDefaultWorkspace &&
      !hasUserSelectedWorkspaceRef.current &&
      allowAuto &&
      !environmentId &&
      (!repository || repository === AUTO_WORKSPACE_VALUE) &&
      sortedEnvironments.length === 1;

    if (hasAppliedDefaultWorkspace && !canRetrySoleDefaultAfterReset) {
      return;
    }

    if (environmentId) {
      setHasAppliedDefaultWorkspace(true);
      return;
    }

    // Keep intentional selections. A legacy Auto value remains eligible for
    // the sole-environment default without being exposed as a picker option.
    if (allowAuto && repository && repository !== AUTO_WORKSPACE_VALUE) {
      setHasAppliedDefaultWorkspace(true);
      return;
    }

    // Auto-select the environment when there's a repositoryFilter with matching environments,
    // or when there's exactly one environment configured (making it the default).
    const shouldAutoSelect =
      (repositoryFilter && sortedEnvironments.length > 0) ||
      sortedEnvironments.length === 1;

    if (!shouldAutoSelect) {
      // Stay open while Auto has zero environments so the sole environment
      // created right after setup can still become the default.
      if (
        allowAuto &&
        sortedEnvironments.length === 0 &&
        (!repository || repository === AUTO_WORKSPACE_VALUE)
      ) {
        return;
      }

      setHasAppliedDefaultWorkspace(true);
      return;
    }

    const defaultEnvironment = sortedEnvironments[0]!;

    setValue('environmentId', defaultEnvironment.id);
    setValue('repository', defaultEnvironment.id);
    setValue('branch', lockedBranch ?? '');

    setWorkspace({
      workspace: { type: 'environment', id: defaultEnvironment.id },
    });

    setHasAppliedDefaultWorkspace(true);
  }, [
    hasAppliedDefaultWorkspace,
    autoSelectDefaultWorkspace,
    allowAuto,
    repositoryFilter,
    environments.isPending,
    environments.isSuccess,
    environmentId,
    repository,
    sortedEnvironments,
    setValue,
    setWorkspace,
    lockedBranch,
  ]);

  useEffect(() => {
    if (!allowAuto) {
      return;
    }

    if (environments.isPending || repositories.isPending) {
      return;
    }

    if (repository === AUTO_WORKSPACE_VALUE) {
      return;
    }

    if (environmentId) {
      if (!environments.isSuccess) {
        return;
      }

      const environmentExists = (environments.data ?? []).some(
        ({ id }) => id === environmentId,
      );

      if (environmentExists) {
        return;
      }

      setValue('environmentId', undefined);
      setValue('repository', AUTO_WORKSPACE_VALUE);
      setValue('branch', '');
      setWorkspace({ workspace: { type: 'auto' } });
      onInvalidWorkspaceReset?.();
      setHasAppliedDefaultWorkspace(false);
      return;
    }

    if (
      !repository ||
      repository === ALL_REPOSITORIES ||
      repository === NO_REPOSITORIES ||
      repository === FAST_EXECUTION
    ) {
      return;
    }

    if (!repositories.isSuccess) {
      return;
    }

    const repositoryExists = (repositories.data ?? []).some(
      ({ fullName }) => fullName === repository,
    );

    if (repositoryExists) {
      return;
    }

    setValue('environmentId', undefined);
    setValue('repository', AUTO_WORKSPACE_VALUE);
    setValue('branch', '');
    setWorkspace({ workspace: { type: 'auto' } });
    onInvalidWorkspaceReset?.();
  }, [
    allowAuto,
    environmentId,
    environments.isPending,
    environments.isSuccess,
    environments.data,
    repositories.isPending,
    repositories.isSuccess,
    repositories.data,
    repository,
    onInvalidWorkspaceReset,
    setValue,
    setWorkspace,
  ]);

  const currentSelection = useMemo(() => {
    if (environmentId) {
      return {
        label: selectedEnv?.name ?? 'Environment',
        icon: VectorSquare,
      };
    }

    if (repository === ALL_REPOSITORIES) {
      return {
        label: 'All Repositories',
        icon: BookCopy,
      };
    }

    if (repository === NO_REPOSITORIES) {
      return {
        label: 'Blank slate',
        icon: SquareDashed,
      };
    }

    if (repository === AUTO_WORKSPACE_VALUE) {
      return {
        label: 'Select a workspace',
        icon: SquareDashed,
      };
    }

    if (repository === FAST_EXECUTION) {
      return {
        label: 'Fast',
        icon: Zap,
      };
    }

    if (!repository) {
      return {
        label: 'Select an environment',
        icon: SquareDashed,
      };
    }

    const repoName = repositories.data?.find(
      ({ fullName }) => fullName === repository,
    )?.name;

    return {
      label: repoName ?? 'Repository',
      icon: BookMarked,
    };
  }, [environmentId, selectedEnv?.name, repository, repositories.data]);

  const handleValueChange = useCallback(
    (value: string) => {
      if (value === CREATE_NEW) {
        onCreate();
        return;
      }

      hasUserSelectedWorkspaceRef.current = true;

      if (value.startsWith(ENV_PREFIX)) {
        const environmentId = value.slice(ENV_PREFIX.length);
        setValue('environmentId', environmentId);
        setValue('repository', environmentId);
        setValue('branch', lockedBranch ?? '');
        setWorkspace({ workspace: { type: 'environment', id: environmentId } });
      } else if (value.startsWith(REPO_PREFIX)) {
        const repository = value.slice(REPO_PREFIX.length);
        setValue('environmentId', undefined);
        setValue('repository', repository);

        if (repository === FAST_EXECUTION) {
          // A Fast chat has no repository workspace; it is not persisted as a
          // default workspace choice.
          setValue('branch', '');
          return;
        }

        if (repository === NO_REPOSITORIES) {
          setValue('branch', '');
          setWorkspace({
            workspace: { type: 'repository', value: repository },
          });
          return;
        }

        if (lockedBranch) {
          setValue('branch', lockedBranch);
        }

        setWorkspace({ workspace: { type: 'repository', value: repository } });
        // Branch will be reset by SelectBranch when repository changes.
      }
    },
    [setValue, onCreate, setWorkspace, lockedBranch],
  );

  const isLoading = environments.isPending || repositories.isPending;

  const isDisabled =
    isLoading ||
    (typeof environments.data === 'undefined' &&
      typeof repositories.data === 'undefined');
  return (
    <FormField
      control={control}
      name="repository"
      render={() => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FormControl>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-auto justify-between border-input bg-card px-3 font-normal hover:bg-card dark:hover:border-input dark:hover:bg-card"
                disabled={isDisabled}
              >
                <span className="inline-flex items-center gap-2 truncate grow text-left">
                  <currentSelection.icon
                    className="size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <span className="truncate">{currentSelection.label}</span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
              </Button>
            </FormControl>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72" align="start">
            {sortedEnvironments.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex gap-2 items-center">
                  Environments
                  {!isAdmin ? (
                    <> (recommended)</>
                  ) : (
                    <InfoTooltip content="Environments contain 1 or more repos (for example, backend + frontend) with instructions for how to run them. This allows for real-time previews and coordinated changes." />
                  )}
                </DropdownMenuLabel>
                {sortedEnvironments.map((env) => (
                  <DropdownMenuItem
                    key={env.id}
                    className="relative group last:rounded-b-none"
                    onSelect={() => handleValueChange(`${ENV_PREFIX}${env.id}`)}
                  >
                    <div className="flex items-center gap-2 min-w-32 truncate">
                      {selectedEnv?.id === env.id ? (
                        <Check
                          className="size-3.5 shrink-0 text-accent-foreground"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <VectorSquare
                          className="size-3.5 shrink-0 text-muted-foreground"
                          strokeWidth={1.5}
                        />
                      )}

                      <span className="truncate no-wrap">{env.name}</span>
                    </div>
                    {isAdmin && (
                      <div
                        className={cn(
                          'absolute flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity right-1',
                          // selectedEnv?.id === env.id ? 'right-8' : 'right-1',
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onEdit(e, env.id);
                          }}
                        >
                          <Settings className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onDelete(e, env);
                          }}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}

            {isAdmin && (
              <>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onCreate();
                  }}
                >
                  <span className="flex items-center gap-2">
                    <Plus className="size-3.5" />
                    Create environment
                  </span>
                </DropdownMenuItem>
                {onCreateRepository ? (
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      onCreateRepository();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Plus className="size-3.5" />
                      New GitHub repository
                    </span>
                  </DropdownMenuItem>
                ) : null}
              </>
            )}

            {sortedEnvironments.length > 0 && <DropdownMenuSeparator />}

            {allRepositories.length > 0 && (
              <DropdownMenuItem
                onSelect={() =>
                  handleValueChange(`${REPO_PREFIX}${ALL_REPOSITORIES}`)
                }
              >
                <div className="flex items-center gap-2">
                  <BookCopy className="size-3.5 shrink-0" strokeWidth={1.5} />
                  <span>All Repositories</span>
                </div>
              </DropdownMenuItem>
            )}

            {allRepositories.length > 0 && <DropdownMenuSeparator />}

            <DropdownMenuItem
              onSelect={() =>
                handleValueChange(`${REPO_PREFIX}${NO_REPOSITORIES}`)
              }
            >
              <div className="flex items-start gap-2">
                <SquareDashed
                  className="mt-0.5 size-3.5 shrink-0"
                  strokeWidth={1.5}
                />
                <div>
                  <div>Blank slate</div>
                  <div className="text-xs text-muted-foreground">
                    Start a sandbox without repositories.
                  </div>
                </div>
              </div>
            </DropdownMenuItem>

            {allowFast && (
              <DropdownMenuItem
                onSelect={() =>
                  handleValueChange(`${REPO_PREFIX}${FAST_EXECUTION}`)
                }
              >
                <div className="flex items-center gap-2">
                  <Zap className="size-3.5 shrink-0" strokeWidth={1.5} />
                  <span>Fast</span>
                </div>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
};
