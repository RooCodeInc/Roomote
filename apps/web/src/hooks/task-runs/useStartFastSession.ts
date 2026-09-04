import { useMutation } from '@tanstack/react-query';

import type {
  ComputeProvider,
  LaunchCodingHarness,
  ReasoningEffort,
} from '@roomote/types';
import { useTRPCClient } from '@/trpc/client';

export function useStartFastSession(options?: {
  onSuccess?: (
    result: StartFastSessionResult,
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

type StartFastSessionResult = {
  sessionId: string;
  fastConversationId?: string;
  /** Set when a pinned launch delegated a task immediately. */
  taskId?: string;
};

type StartFastSessionVariables = {
  text: string;
  images?: string[];
  attachmentTexts?: string[];
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  /** Stable identity used to make a start retry idempotent. */
  conversationId?: string;
  /** Persist the Session without scheduling an initial Fast turn. */
  empty?: true;
  /** Launch into a chosen workspace without a Fast decision. */
  pinnedLaunch?: {
    launchId: string;
    repo: string;
    branch?: string;
    sha?: string;
    environmentId?: string;
    harness?: LaunchCodingHarness;
    computeProvider?: ComputeProvider;
  };
};
