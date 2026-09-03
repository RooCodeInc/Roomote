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
      title="I found stuff I can work on"
      icon={<ListChecks />}
      intro="Choose as many as you want, I'll create PRs for you to review"
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
