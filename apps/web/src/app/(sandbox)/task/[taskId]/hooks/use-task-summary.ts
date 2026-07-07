import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import { useLLMEnhancedFeatures } from '@/hooks/llm-features';

interface UseTaskSummaryOptions {
  enabled?: boolean;
}

const SUMMARY_UNAVAILABLE_MESSAGE =
  'Summary is temporarily unavailable. Try again in a moment.';

function getSummaryErrorMessage(error: string | null | undefined) {
  if (!error || error === 'not_enough_messages') {
    return null;
  }

  return SUMMARY_UNAVAILABLE_MESSAGE;
}

export function useTaskSummary(
  taskId: string,
  options?: UseTaskSummaryOptions,
) {
  const trpc = useTRPC();
  const llmFeatures = useLLMEnhancedFeatures();
  const queryEnabled = llmFeatures.enabled && (options?.enabled ?? true);

  const {
    data: summaryResult,
    isFetching: isLoadingSummary,
    error: queryError,
    refetch: regenerateSummary,
  } = useQuery(
    trpc.tasks.generateSummary.queryOptions(
      { taskId },
      {
        enabled: queryEnabled,
        staleTime: Infinity,
        gcTime: 1000 * 60 * 60 * 24, // 24 hours.
      },
    ),
  );

  const summary = summaryResult?.success ? summaryResult.summary : null;

  const errorMessage =
    summaryResult && !summaryResult.success
      ? getSummaryErrorMessage(summaryResult.error)
      : queryError
        ? SUMMARY_UNAVAILABLE_MESSAGE
        : null;

  const enabled =
    queryEnabled &&
    (!summaryResult ||
      summaryResult.success ||
      summaryResult.error !== 'not_enough_messages');

  const isSummaryStale = summaryResult?.success
    ? summaryResult.messageCount > summaryResult.generatedForMessageCount
    : false;

  return {
    enabled,
    summary,
    isLoadingSummary,
    errorMessage,
    isSummaryStale,
    regenerateSummary,
  };
}
