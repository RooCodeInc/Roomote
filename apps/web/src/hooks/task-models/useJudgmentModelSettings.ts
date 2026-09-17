'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

/** Judgment model status for Settings > Models. Never includes a key. */
export function useJudgmentModelSettings() {
  const trpc = useTRPC();

  return useQuery(trpc.taskModels.judgment.get.queryOptions());
}
