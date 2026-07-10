import type {
  UseMutationOptions,
  UseMutationResult,
} from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';

import type { LaunchCodingHarness } from '@roomote/types';
import { type CreateTaskRunResult } from '@/trpc/commands/task-runs';
import { useTRPCClient } from '@/trpc/client';

type ManualTaskRunVariables = {
  harness?: LaunchCodingHarness;
  model?: string;
  computeProvider?: import('@roomote/types').ComputeProvider;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  sourceArtifactPath?: string;
  sourceArtifactVersion?: number;
  payload: {
    repo: string;
    branch?: string;
    sha?: string;
    environmentId?: string;
    description?: string;
    images?: string[];
    blank?: boolean;
  };
};

export function useCreateStandardTaskRun(
  options: Omit<
    UseMutationOptions<CreateTaskRunResult, Error, ManualTaskRunVariables>,
    'mutationFn'
  > = {},
): UseMutationResult<CreateTaskRunResult, Error, ManualTaskRunVariables> {
  const trpcClient = useTRPCClient();
  const { onSuccess, ...restOptions } = options;

  return useMutation({
    mutationFn: (variables) =>
      trpcClient.taskRuns.createStandardTask.mutate({
        ...variables,
        payload: variables.payload,
      }),
    onSuccess: (data, variables, onMutateResult, context) => {
      onSuccess?.(data, variables, onMutateResult, context);
    },
    ...restOptions,
  });
}
