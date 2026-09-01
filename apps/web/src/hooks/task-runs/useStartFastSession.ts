import { useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

export function useStartFastSession(options?: {
  onSuccess?: (
    result: { sessionId: string },
    variables: StartFastSessionVariables,
  ) => void;
  onError?: (error: Error) => void;
}) {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables: StartFastSessionVariables) =>
      trpcClient.fastSessions.start.mutate(variables),
    ...options,
  });
}

type StartFastSessionVariables = {
  text: string;
  images?: string[];
  attachmentTexts?: string[];
  model?: string;
  artifactBuild?: {
    launchId: string;
    environmentId: string;
    branch?: string;
    taskModel: string;
    sourceTaskId: string;
    sourceArtifactId: string;
    sourceArtifactPath: string;
    sourceArtifactVersion: number;
  };
};
