'use client';

import Link from 'next/link';
import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, FormProvider } from 'react-hook-form';
import { toast } from 'sonner';

import { PRODUCT_NAME } from '@roomote/types';

import type { CreateCloudTask } from '@/types';

import { cn } from '@/lib/utils';
import { processImageFiles } from '@/lib';
import { SETTINGS_PATHS } from '@/lib/settings';

import { useCreateStandardTaskCloudJob } from '@/hooks/cloud-jobs';
import { useEnvironments } from '@/hooks/environments';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';

import { GitPullRequest, GitBranch, Badge } from '@/components/system';
import { type PromptInputMessage } from '@/components/ai-elements';
import {
  SelectWorkspace,
  ModelSelect,
  TaskPromptInput,
} from '@/components/tasks';

const DEFAULT_PLACEHOLDER = 'What do you want to do?';

type PreviewEnvironmentProps = {
  repo: string;
  sha: string;
  pr: number;
  branch: string;
};

export function PreviewEnvironment({
  repo,
  sha,
  pr,
  branch: initialBranch,
}: PreviewEnvironmentProps) {
  const router = useRouter();
  const environments = useEnvironments();
  const form = useForm<CreateCloudTask>({
    defaultValues: {
      repository: repo,
      branch: initialBranch,
      environmentId: undefined,
      text: '',
      images: [],
      port: undefined,
    },
  });

  const [promptText, setPromptText] = useState('');
  const [isExiting, setIsExiting] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const launchTaskModels = useLaunchTaskModels();
  const selectedEnvironmentId = form.watch('environmentId');
  const submitDisabledReason = selectedEnvironmentId
    ? undefined
    : 'Select an environment before starting a task.';
  const launchHint = submitDisabledReason ? (
    <p className="text-sm text-muted-foreground">
      <Link
        href={SETTINGS_PATHS.newEnvironment}
        className="text-primary underline hover:no-underline"
      >
        Create an environment
      </Link>{' '}
      or select one above before starting a task.
    </p>
  ) : undefined;

  useEffect(() => {
    if (selectedModelId || !launchTaskModels.data?.defaultModelId) {
      return;
    }

    setSelectedModelId(launchTaskModels.data.defaultModelId);
  }, [launchTaskModels.data?.defaultModelId, selectedModelId]);

  const navigateToJob = useCallback(
    (result: { success: boolean; taskId?: string; error?: string }) => {
      if (result.success && 'taskId' in result) {
        setIsExiting(true);
        router.push(`/task/${result.taskId}`);
      } else if ('error' in result) {
        toast.error(result.error);
      }
    },
    [router],
  );

  const mutationOptions = useCallback(
    () => ({
      onSuccess: navigateToJob,
      onError: (error: Error) => toast.error(error.message),
    }),
    [navigateToJob],
  );

  const createStandardTaskJob =
    useCreateStandardTaskCloudJob(mutationOptions());

  const isBusy = createStandardTaskJob.isPending;

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const { repository, branch, environmentId } = form.getValues();
      const payloadRepo = environmentId ? repo : repository || repo;
      const payloadSha = payloadRepo === repo ? sha : undefined;
      const text = message.text.trim();

      let images: string[] | undefined;

      if (message.files?.length) {
        const fileObjects = await Promise.all(
          message.files
            .filter((f) => f.url)
            .map(async (f) => {
              const response = await fetch(f.url!);
              const blob = await response.blob();

              return new File([blob], f.filename || 'image', {
                type: f.mediaType || blob.type,
              });
            }),
        );

        const processed = await processImageFiles(fileObjects);
        images = processed.map((p) => p.dataUrl);
      }

      await createStandardTaskJob.mutateAsync({
        model: selectedModelId,
        payload: {
          repo: payloadRepo,
          branch,
          sha: payloadSha,
          environmentId,
          description: text,
          images,
        },
      });
    },
    [createStandardTaskJob, form, repo, selectedModelId, sha],
  );

  return (
    <FormProvider {...form}>
      <div className="flex flex-1 md:items-center py-6 justify-center h-effective-viewport">
        <div
          className={cn(
            'flex w-full max-w-3xl flex-col gap-4 md:gap-3 px-4',
            isExiting && 'animate-[exit-right_500ms_1_forwards]',
          )}
        >
          {/* Header */}
          <div className="flex flex-col gap-2 animate-[enter-down_1s_1]">
            <h1 className="text-2xl tracking-tight font-bold">
              Open in {PRODUCT_NAME}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="gap-1.5 font-mono">
                <GitPullRequest className="size-3.5" />
                {repo}#{pr}
              </Badge>
              <Badge variant="outline" className="gap-1.5 font-mono">
                <GitBranch className="size-3.5" />
                {initialBranch}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 animate-[enter-down_1s_1_100ms_backwards]">
            <SelectWorkspace
              repositoryFilter={repo}
              lockedBranch={initialBranch}
            />
            <ModelSelect
              value={selectedModelId}
              onValueChange={setSelectedModelId}
            />
          </div>

          <TaskPromptInput
            isBusy={isBusy}
            promptText={promptText}
            onPromptTextChange={setPromptText}
            onSubmit={handleSubmit}
            placeholder={DEFAULT_PLACEHOLDER}
            autoFocus
            submitDisabledReason={
              environments.data && environments.data.length === 0
                ? 'Create an environment before starting a task.'
                : submitDisabledReason
            }
            suggestion={launchHint}
          />
        </div>
      </div>
    </FormProvider>
  );
}
