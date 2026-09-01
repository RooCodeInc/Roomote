'use client';

import type { AcpRequestUserInputPayload } from '@roomote/types';

import { ListChecks } from '@/components/system';

import { SessionUserInputCard } from '../SessionUserInputCard';
import { SetupSessionActionCard } from './SetupSessionActionCard';

export function SetupStarterTasksCard({
  sessionId,
  request,
}: {
  sessionId: string;
  request: Pick<
    AcpRequestUserInputPayload,
    'requestId' | 'questions' | 'preset'
  >;
}) {
  return (
    <SetupSessionActionCard
      title="Choose your first task"
      icon={<ListChecks />}
      intro="Pick what you would like me to work on first. You can choose more than one."
    >
      <SessionUserInputCard
        sessionId={sessionId}
        request={request}
        submission="setup"
        cancellable={false}
      />
    </SetupSessionActionCard>
  );
}
