'use client';

import { useMutation } from '@tanstack/react-query';

import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

import { StepAutomationRecommendations } from './StepAutomationRecommendations';

/**
 * Inline automation-recommendations card. Rendered in the conversational
 * setup workspace and in the setup session's normal route after activation.
 * Apply or Skip notifies Roomote so it can acknowledge the choice and
 * continue naturally. Optional: never blocks activation or launched tasks.
 */
export function SetupRecommendationsInlineCard() {
  const trpc = useTRPC();
  const { user } = useUser();
  const notifyRecommendationChoice = useMutation(
    trpc.setup.sessionMilestone.mutationOptions(),
  );

  if (user?.isAdmin !== true) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="mb-3 text-sm font-medium">Recommended automations</p>
      <StepAutomationRecommendations
        onContinue={() => {
          notifyRecommendationChoice.mutate({
            milestone: 'recommendations_notified',
            eventType: 'recommendations_decided',
          });
        }}
      />
    </div>
  );
}
