'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from '@/components/system';
import { z } from 'zod';

import { ALL_REPOSITORIES } from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useWorkspaceStorage } from '@/hooks/useWorkspaceStorage';
import { SETTINGS_PATHS } from '@/lib/settings';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
} from '@/components/system';

import { SelectWorkspace } from './SelectWorkspace';
import { ModelSelect } from './ModelSelect';

/**
 * Form schema for selecting where to build the artifact.
 * Uses the same structure as CreateCloudTask but only the fields needed for workspace selection.
 */
const buildArtifactFormSchema = z.object({
  repository: z.string().min(1, 'Repository is required.'),
  branch: z.string().optional(),
  environmentId: z.string().uuid().optional(),
  modelId: z.string().min(1, 'Model is required.'),
});

type BuildArtifactFormValues = z.infer<typeof buildArtifactFormSchema>;

interface BuildArtifactConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactName: string;
  artifactVersion: number;
  taskRepository?: string;
  taskBranch?: string;
  taskEnvironmentId?: string;
  onConfirm: (values: {
    repo: string;
    branch?: string;
    environmentId?: string;
    modelId: string;
  }) => void;
  isPending?: boolean;
}

/**
 * Dialog that asks the user to confirm where they want to build an artifact (plan).
 * Reuses the SelectWorkspace component from the new task flow.
 */
export function BuildArtifactConfirmDialog({
  open,
  onOpenChange,
  artifactName,
  artifactVersion,
  taskRepository,
  taskBranch,
  taskEnvironmentId,
  onConfirm,
  isPending = false,
}: BuildArtifactConfirmDialogProps) {
  const { user } = useUser();

  if (!open || !user) {
    return null;
  }

  return (
    <BuildArtifactConfirmDialogForm
      open={open}
      onOpenChange={onOpenChange}
      artifactName={artifactName}
      artifactVersion={artifactVersion}
      taskRepository={taskRepository}
      taskBranch={taskBranch}
      taskEnvironmentId={taskEnvironmentId}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}

function BuildArtifactConfirmDialogForm({
  open,
  onOpenChange,
  artifactName,
  artifactVersion,
  taskRepository,
  taskBranch,
  taskEnvironmentId,
  onConfirm,
  isPending = false,
}: BuildArtifactConfirmDialogProps) {
  const { workspace } = useWorkspaceStorage();
  const launchTaskModels = useLaunchTaskModels();

  const recentRepository =
    workspace.workspace?.type === 'repository'
      ? workspace.workspace.value
      : undefined;

  const recentEnvironmentId =
    workspace.workspace?.type === 'environment'
      ? workspace.workspace.id
      : undefined;

  const form = useForm<BuildArtifactFormValues>({
    resolver: zodResolver(buildArtifactFormSchema),
    defaultValues: {
      // Prefer the originating task's workspace, fall back to user's last workspace selection.
      repository: taskRepository || recentRepository || ALL_REPOSITORIES,
      branch: taskBranch || '',
      environmentId: taskEnvironmentId ?? recentEnvironmentId,
      modelId: '',
    },
  });

  useEffect(() => {
    if (!launchTaskModels.data?.defaultModelId || form.getValues('modelId')) {
      return;
    }

    form.setValue('modelId', launchTaskModels.data.defaultModelId);
  }, [form, launchTaskModels.data?.defaultModelId]);
  const selectedEnvironmentId = form.watch('environmentId');
  const environmentRequired = !selectedEnvironmentId;

  const handleSubmit = (values: BuildArtifactFormValues) => {
    onConfirm({
      repo: values.repository,
      branch: values.branch,
      environmentId: values.environmentId,
      modelId: values.modelId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Build this plan
          </DialogTitle>
          <DialogDescription>
            Where should <strong>{artifactName}</strong> (v{artifactVersion}) be
            built?
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              <SelectWorkspace />

              <ModelSelect
                value={form.watch('modelId')}
                onValueChange={(value) => form.setValue('modelId', value)}
                disabled={isPending}
              />
            </div>

            {environmentRequired ? (
              <p className="text-sm text-muted-foreground">
                <Link
                  href={SETTINGS_PATHS.newEnvironment}
                  className="text-primary underline hover:no-underline"
                >
                  Create an environment
                </Link>{' '}
                or select one above before starting this task.
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || environmentRequired}>
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>Build</>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
