'use client';

import { useQuery } from '@tanstack/react-query';

import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import { Zap } from '@/components/system';

import { StepAutomationRecommendations } from './StepAutomationRecommendations';
import { SetupSessionActionCard } from './SetupSessionActionCard';

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
    <SetupSessionActionCard
      title="Recommended automations"
      icon={<Zap className="size-4" />}
      intro="Review the recurring work I found in your repositories, then choose what to turn on."
    >
      <StepAutomationRecommendations onContinue={() => undefined} embedded />
    </SetupSessionActionCard>
  );
}
