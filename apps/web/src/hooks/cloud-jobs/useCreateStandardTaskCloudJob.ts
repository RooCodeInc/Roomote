import type {
  UseMutationOptions,
  UseMutationResult,
} from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';

import type { LaunchCodingHarness } from '@roomote/types';
import { type CreateCloudJobResult } from '@/trpc/commands/cloud-jobs';
import { useTRPCClient } from '@/trpc/client';

type ManualCloudJobVariables = {
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

export function useCreateStandardTaskCloudJob(
  options: Omit<
    UseMutationOptions<CreateCloudJobResult, Error, ManualCloudJobVariables>,
    'mutationFn'
  > = {},
): UseMutationResult<CreateCloudJobResult, Error, ManualCloudJobVariables> {
  const trpcClient = useTRPCClient();
  const { onSuccess, ...restOptions } = options;

  return useMutation({
    mutationFn: (variables) =>
      trpcClient.cloudJobs.createStandardTask.mutate({
        ...variables,
        payload: variables.payload,
      }),
    onSuccess: (data, variables, onMutateResult, context) => {
      onSuccess?.(data, variables, onMutateResult, context);
    },
    ...restOptions,
  });
}
