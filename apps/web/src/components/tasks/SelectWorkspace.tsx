'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useFormContext } from 'react-hook-form';

import { ALL_REPOSITORIES } from '@roomote/types';

import type { CreateTaskFormValues } from '@/types';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import { SETTINGS_PATHS } from '@/lib/settings';

import { DeleteEnvironmentDialog } from '@/components/settings/environments';
import { AUTO_WORKSPACE_VALUE } from './constants';

import { SelectEnvironmentOrRepository } from './SelectEnvironmentOrRepository';
import { SelectBranch } from './SelectBranch';

export const SelectWorkspace = ({
  repositoryFilter,
  lockedBranch,
  allowAuto = false,
  allowFast = false,
  allowBranchSelection = true,
  environmentBranchRepositoryFullName,
  environmentBranchDefault,
}: {
  repositoryFilter?: string;
  lockedBranch?: string;
  allowAuto?: boolean;
  allowFast?: boolean;
  allowBranchSelection?: boolean;
  environmentBranchRepositoryFullName?: string;
  environmentBranchDefault?: string;
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const router = useRouter();

  const [deletingEnvironment, setDeletingEnvironment] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const { watch, setValue } = useFormContext<CreateTaskFormValues>();
  const environmentId = watch('environmentId');
  const repository = watch('repository');
  const canSelectRepositoryBranch =
    allowBranchSelection &&
    !lockedBranch &&
    !environmentId &&
    repository &&
    repository !== ALL_REPOSITORIES &&
    repository !== AUTO_WORKSPACE_VALUE;
  const canSelectEnvironmentBranch =
    allowBranchSelection &&
    !lockedBranch &&
    environmentId &&
    environmentBranchRepositoryFullName;

  const handleCreateEnvironment = useCallback(() => {
    router.push(SETTINGS_PATHS.newEnvironment);
  }, [router]);

  const handleCreateRepository = useCallback(() => {
    router.push(`${SETTINGS_PATHS.newEnvironment}?create-repo=1`);
  }, [router]);

  const handleUpdateEnvironment = useCallback(
    (e: React.MouseEvent, envId: string) => {
      e.preventDefault();
      e.stopPropagation();
      router.push(SETTINGS_PATHS.editEnvironment(envId));
    },
    [router],
  );

  const handleDeleteEnvironment = useCallback(
    (e: React.MouseEvent, env: EnvironmentWithMeta) => {
      e.preventDefault();
      e.stopPropagation();
      setDeletingEnvironment(env);
      setDeleteDialogOpen(true);
    },
    [],
  );

  const handleDeleted = useCallback(() => {
    // If the deleted environment was selected, clear the selection.
    if (environmentId === deletingEnvironment?.id) {
      setValue('environmentId', undefined);
      setValue('repository', ALL_REPOSITORIES);
    }

    setDeleteDialogOpen(false);
    setDeletingEnvironment(null);
  }, [deletingEnvironment, environmentId, setValue]);

  const handleDeleteDialogOpenChange = useCallback((open: boolean) => {
    setDeleteDialogOpen(open);

    if (!open) {
      setDeletingEnvironment(null);
    }
  }, []);

  return (
    <>
      <div className="flex flex-col md:flex-row flex-wrap gap-2 md:items-center md:w-auto">
        <SelectEnvironmentOrRepository
          repositoryFilter={repositoryFilter}
          lockedBranch={lockedBranch}
          allowAuto={allowAuto}
          allowFast={allowFast}
          onCreate={handleCreateEnvironment}
          onCreateRepository={handleCreateRepository}
          onEdit={handleUpdateEnvironment}
          onDelete={handleDeleteEnvironment}
        />

        {canSelectEnvironmentBranch ? (
          <SelectBranch
            repositoryFullName={environmentBranchRepositoryFullName}
            defaultBranch={environmentBranchDefault}
          />
        ) : canSelectRepositoryBranch ? (
          <SelectBranch />
        ) : null}
      </div>

      <DeleteEnvironmentDialog
        open={deleteDialogOpen}
        onOpenChange={handleDeleteDialogOpenChange}
        environment={deletingEnvironment}
        onDeleted={handleDeleted}
      />
    </>
  );
};
