'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { ComputeProvider } from '@roomote/types';
import {
  Plus,
  Trash2,
  Pencil,
  Copy,
  ChevronDown,
  BookMarked,
  Camera,
  X,
  VectorSquare,
  TriangleAlert,
} from '@/components/system';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';

import { SETTINGS_PATHS } from '@/lib/settings';
import {
  useEnvironments,
  useDeleteEnvironment,
  useDuplicateEnvironment,
} from '@/hooks/environments';
import {
  useCreateEnvironmentSnapshot,
  useClearEnvironmentSnapshot,
} from '@/hooks/snapshots';
import { useRepositories } from '@/hooks/source-control';
import { useAuthorizedUser } from '@/hooks/useUser';

import {
  Badge,
  BasicTooltip,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from '@/components/system';
import { Loading } from '@/components/layout';
import { Section } from '@/components/settings';

import { DuplicateEnvironmentDialog } from './DuplicateEnvironmentDialog';
import { SnapshotStatusBadge } from './SnapshotStatusBadge';
import { EnvironmentVerificationStatus } from './EnvironmentVerificationStatus';

function getEnvironmentSnapshot(
  environment: EnvironmentWithMeta,
  provider: ComputeProvider,
) {
  return environment.snapshots[provider];
}

function getEnvironmentDescription(environment: EnvironmentWithMeta) {
  return environment.description || environment.config.description || '';
}

export function Environments() {
  const [environmentToDuplicate, setEnvironmentToDuplicate] =
    useState<EnvironmentWithMeta>();
  const { isAdmin } = useAuthorizedUser();
  const environments = useEnvironments({ poll: true });
  const repositories = useRepositories();
  const deleteEnvironment = useDeleteEnvironment();
  const duplicateEnvironment = useDuplicateEnvironment();
  const createEnvironmentSnapshot = useCreateEnvironmentSnapshot();
  const clearEnvironmentSnapshot = useClearEnvironmentSnapshot();
  const allSnapshotProviders: ComputeProvider[] = ['modal', 'e2b'];

  if (environments.isPending || repositories.isPending) {
    return (
      <Section icon={VectorSquare} title="Environments">
        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-12 w-64" />
                </div>
                <div className="flex items-center gap-2">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="size-5 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section
        icon={VectorSquare}
        title="Environments"
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={SETTINGS_PATHS.newEnvironment}>
                <Plus />
                Add
              </Link>
            </Button>
          ) : undefined
        }
      >
        {!environments.data || environments.data.length === 0 ? (
          <p>
            <TriangleAlert className="inline size-4 mr-2" />
            Roomote can only verify its work when running with an environment.
            Add your first now.
          </p>
        ) : (
          <div className="space-y-4 divide-y -mb-2">
            {environments.data.map((env) => {
              const description = getEnvironmentDescription(env);
              const visibleSnapshotProviders: ComputeProvider[] =
                allSnapshotProviders;

              return (
                <div key={env.id} className="space-y-4">
                  <Collapsible className="space-y-2">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium leading-5">{env.name}</p>
                          {env.declarativeSource ? (
                            <BasicTooltip
                              content={`Provisioned from ${env.declarativeSource} at deployment startup. Edits are kept until the next restart re-applies the declarative definition.`}
                            >
                              <Badge variant="outline">Managed from file</Badge>
                            </BasicTooltip>
                          ) : null}
                        </div>
                        {description ? (
                          <p className="text-sm text-muted-foreground">
                            {description}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center gap-2 self-start sm:items-start">
                        {isAdmin ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit environment"
                              aria-label="Edit environment"
                              asChild
                            >
                              <Link
                                href={SETTINGS_PATHS.editEnvironment(env.id)}
                              >
                                <Pencil className="size-4" />
                              </Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setEnvironmentToDuplicate(env)}
                              title="Duplicate"
                              aria-label="Duplicate"
                            >
                              <Copy className="size-4" />
                            </Button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-destructive hover:text-destructive"
                                  title="Delete"
                                  aria-label="Delete"
                                >
                                  {deleteEnvironment.isPending &&
                                  deleteEnvironment.variables?.id === env.id ? (
                                    <Loading className="text-muted-foreground" />
                                  ) : (
                                    <Trash2 className="size-4" />
                                  )}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-64">
                                <p className="mb-2 text-sm font-medium">
                                  Delete environment?
                                </p>
                                <p className="mb-3 text-sm text-muted-foreground">
                                  This will permanently delete &quot;{env.name}
                                  &quot; and all of its snapshots.
                                </p>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() =>
                                      deleteEnvironment.mutate({ id: env.id })
                                    }
                                    disabled={deleteEnvironment.isPending}
                                  >
                                    {deleteEnvironment.isPending &&
                                    deleteEnvironment.variables?.id ===
                                      env.id ? (
                                      <Loading className="text-muted-foreground" />
                                    ) : (
                                      'Delete'
                                    )}
                                  </Button>
                                </div>
                              </PopoverContent>
                            </Popover>
                          </>
                        ) : null}
                        <CollapsibleTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="group"
                            title="Toggle environment details"
                            aria-label="Toggle environment details"
                          >
                            <ChevronDown className="size-4 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                    </div>

                    <CollapsibleContent className="space-y-2 pt-1 border-l-2 mb-2 pl-3">
                      <div className="flex flex-wrap gap-2">
                        {env.config.repositories?.map((repo, idx) => (
                          <div
                            key={`${repo.repository}-${idx}`}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground"
                          >
                            <BookMarked className="size-3 shrink-0" />
                            <span className="ph-no-capture">
                              {repo.repository}
                            </span>
                          </div>
                        ))}
                      </div>

                      <EnvironmentVerificationStatus env={env} />

                      <div className="space-y-2 pb-2">
                        <div className="space-y-0">
                          {visibleSnapshotProviders.map((provider) => {
                            const snapshot = getEnvironmentSnapshot(
                              env,
                              provider,
                            );
                            const requestedProvider = provider;
                            const isCreatingSnapshot =
                              createEnvironmentSnapshot.isPending &&
                              createEnvironmentSnapshot.variables
                                ?.environmentId === env.id &&
                              createEnvironmentSnapshot.variables?.provider ===
                                requestedProvider;
                            const isClearingSnapshot =
                              clearEnvironmentSnapshot.isPending &&
                              clearEnvironmentSnapshot.variables
                                ?.environmentId === env.id &&
                              clearEnvironmentSnapshot.variables?.provider ===
                                requestedProvider;

                            return (
                              <div
                                key={provider}
                                className="flex flex-wrap items-center gap-2"
                              >
                                <span className="text-xs text-muted-foreground capitalize">
                                  {provider} ·
                                </span>
                                {snapshot?.snapshotStatus ? (
                                  <SnapshotStatusBadge
                                    status={snapshot.snapshotStatus}
                                    expiresAt={snapshot.snapshotExpiresAt}
                                    createdAt={snapshot.snapshotCreatedAt}
                                  />
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    No snapshot
                                  </span>
                                )}
                                <div className="flex items-center gap-1">
                                  {snapshot?.snapshotStatus === 'ready' ? (
                                    <Popover>
                                      <PopoverTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 w-7 p-0"
                                          disabled={isClearingSnapshot}
                                          title={`Clear ${provider} snapshot`}
                                          aria-label={`Clear ${provider} snapshot`}
                                        >
                                          <X className="size-3" />
                                        </Button>
                                      </PopoverTrigger>
                                      <PopoverContent className="w-64">
                                        <p className="mb-2 text-sm font-medium">
                                          Clear {provider} snapshot?
                                        </p>
                                        <p className="mb-3 text-sm text-muted-foreground">
                                          This only removes the {provider}{' '}
                                          snapshot for this environment.
                                        </p>
                                        <div className="flex justify-end gap-2">
                                          <Button
                                            variant="destructive"
                                            size="sm"
                                            onClick={() =>
                                              clearEnvironmentSnapshot.mutate({
                                                environmentId: env.id,
                                                provider: requestedProvider,
                                              })
                                            }
                                            disabled={isClearingSnapshot}
                                          >
                                            {isClearingSnapshot ? (
                                              <Loading className="text-muted-foreground" />
                                            ) : (
                                              'Clear'
                                            )}
                                          </Button>
                                        </div>
                                      </PopoverContent>
                                    </Popover>
                                  ) : null}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={async () => {
                                      const result =
                                        await createEnvironmentSnapshot.mutateAsync(
                                          {
                                            environmentId: env.id,
                                            provider: requestedProvider,
                                          },
                                        );

                                      if (result.success) {
                                        toast.success(
                                          `${provider[0]!.toUpperCase()}${provider.slice(1)} snapshot creation started`,
                                        );
                                      }
                                    }}
                                    disabled={
                                      snapshot?.snapshotStatus === 'pending' ||
                                      isCreatingSnapshot
                                    }
                                    title={
                                      snapshot?.snapshotStatus === 'failed'
                                        ? `Retry ${provider} snapshot`
                                        : snapshot?.snapshotId
                                          ? `Refresh ${provider} snapshot`
                                          : `Create ${provider} snapshot`
                                    }
                                    aria-label={
                                      snapshot?.snapshotStatus === 'failed'
                                        ? `Retry ${provider} snapshot`
                                        : snapshot?.snapshotId
                                          ? `Refresh ${provider} snapshot`
                                          : `Create ${provider} snapshot`
                                    }
                                  >
                                    {isCreatingSnapshot ? (
                                      <Loading className="text-muted-foreground" />
                                    ) : (
                                      <Camera className="size-4" />
                                    )}
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <DuplicateEnvironmentDialog
        open={!!environmentToDuplicate}
        onOpenChange={(open) =>
          setEnvironmentToDuplicate(open ? environmentToDuplicate : undefined)
        }
        environment={environmentToDuplicate}
        onDuplicate={async ({ id }, newName) => {
          const result = await duplicateEnvironment.mutateAsync({
            id,
            newName,
          });

          if (result.success) {
            setEnvironmentToDuplicate(undefined);
          }
        }}
        isPending={duplicateEnvironment.isPending}
      />
    </>
  );
}
