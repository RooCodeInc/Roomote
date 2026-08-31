'use client';

import { useQuery } from '@tanstack/react-query';

import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

import { StepAutomationRecommendations } from './StepAutomationRecommendations';

/**
 * Inline automation-recommendations card. Rendered in the conversational
 * setup workspace and in the setup session's normal route after activation.
 * Apply or Skip notifies Roomote so it can acknowledge the choice and
 * continue naturally. Optional: never blocks activation or launched tasks.
 */
export function SetupRecommendationsInlineCard({
  sessionId,
}: {
  sessionId: string;
}) {
  const trpc = useTRPC();
  const { user } = useUser();
  const status = useQuery(trpc.setupNew.status.queryOptions());
  const tasks = useQuery(trpc.fastSessions.tasks.queryOptions({ sessionId }));

  if (
    user?.isAdmin !== true ||
    status.data?.setupNewState.automationRecommendations?.status !== 'ready' ||
    !tasks.data?.length
  ) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="mb-3 text-sm font-medium">Recommended automations</p>
      <StepAutomationRecommendations onContinue={() => undefined} />
    </div>
  );
}
