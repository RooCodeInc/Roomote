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
      title="First task ideas"
      icon={<ListChecks />}
      intro="Optional: choose something I can start working on right away."
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
