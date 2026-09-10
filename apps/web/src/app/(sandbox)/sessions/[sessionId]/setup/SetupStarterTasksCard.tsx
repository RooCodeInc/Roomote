'use client';

import { useEffect, useRef } from 'react';

import type { AcpRequestUserInputPayload } from '@roomote/types';

import { ListChecks } from '@/components/system';
import { useTelemetry } from '@/hooks/useTelemetry';
import { SETUP_STARTER_TASKS } from '@/lib/setup-starter-tasks';

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
  const { enabled, capture } = useTelemetry();
  const lastShownRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || lastShownRequestIdRef.current === request.requestId) {
      return;
    }

    const offeredTaskIds = [
      ...new Set(
        request.questions.flatMap((question) =>
          (question.options ?? []).flatMap((option) => {
            const task = SETUP_STARTER_TASKS.find(
              (candidate) => candidate.title === option.label,
            );
            return task ? [task.id] : [];
          }),
        ),
      ),
    ];
    lastShownRequestIdRef.current = request.requestId;
    capture('setup_starter_tasks_shown', {
      offeredCount: offeredTaskIds.length,
      starterTaskIds: offeredTaskIds.join(','),
    });
  }, [capture, enabled, request]);

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
