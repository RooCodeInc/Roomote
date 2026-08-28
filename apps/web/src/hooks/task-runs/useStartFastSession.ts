import { useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

export function useStartFastSession(options?: {
  onSuccess?: (result: { sessionId: string }) => void;
  onError?: (error: Error) => void;
}) {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables: {
      text: string;
      images?: string[];
      attachmentTexts?: string[];
    }) => trpcClient.fastSessions.start.mutate(variables),
    ...options,
  });
}
