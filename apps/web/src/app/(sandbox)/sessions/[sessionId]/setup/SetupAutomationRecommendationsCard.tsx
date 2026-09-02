'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import { Zap } from '@/components/system';

import { AutomationRecommendations } from './AutomationRecommendations';
import { SetupSessionActionCard } from './SetupSessionActionCard';

/**
 * Inline automation-recommendations card. Rendered in the conversational
 * setup workspace and in the setup session's normal route after activation.
 * Enabling the selection adds a transcript-only acknowledgement and dismisses
 * the card. Optional: never blocks activation or launched tasks.
 */
export function SetupAutomationRecommendationsCard({
  sessionId,
}: {
  sessionId: string;
}) {
  const trpc = useTRPC();
  const { user } = useUser();
  const [dismissed, setDismissed] = useState(false);
  const status = useQuery(trpc.setupNew.status.queryOptions());
  const tasks = useQuery(trpc.fastSessions.tasks.queryOptions({ sessionId }));
  const recommendations = status.data?.setupNewState.automationRecommendations;

  if (
    dismissed ||
    user?.isAdmin !== true ||
    recommendations?.status !== 'ready' ||
    recommendations.dismissed ||
    (recommendations.applicationState ?? 'pending') !== 'pending' ||
    !tasks.data?.length
  ) {
    return null;
  }

  return (
    <SetupSessionActionCard
      title="I found some stuff to automate"
      icon={<Zap />}
      intro="Looking at your repos, I recommend enabling these to run in the background and do work on your behalf."
    >
      <AutomationRecommendations onContinue={() => setDismissed(true)} />
    </SetupSessionActionCard>
  );
}
