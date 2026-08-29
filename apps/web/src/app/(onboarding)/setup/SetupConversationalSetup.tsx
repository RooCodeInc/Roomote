'use client';

import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import type { FastSessionMessage } from '@/lib/server/fast-sessions';

import { FastSessionTranscript } from '../../(sandbox)/sessions/[sessionId]/FastSessionTranscript';
import { StepAutomationRecommendations } from './StepAutomationRecommendations';
import {
  SetupSourceControlPanelSurface,
  useSetupRecommendationNotifications,
  useSetupRouteTransition,
  useSetupSourceControlMilestoneEffect,
  useSetupSourceControlStatus,
} from './SetupSourceControlPanel';

/**
 * Conversational setup workspace: the persisted Fast transcript is the
 * primary surface, with the trusted source-control side panel (sheet on
 * smaller screens) and inline automation recommendations around it.
 */
export function SetupConversationalSetup() {
  const trpc = useTRPC();
  const { isSignedIn, user } = useUser();
  const isAdmin = user?.isAdmin === true;
  const enabled = isSignedIn && isAdmin;

  const statusQuery = useQuery(
    trpc.setup.sessionStatus.queryOptions(undefined, { enabled }),
  );
  const createSession = useMutation(
    trpc.setup.getOrCreateSession.mutationOptions(),
  );

  useEffect(() => {
    if (enabled && statusQuery.data?.sessionId == null) {
      createSession.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, statusQuery.data?.sessionId]);

  const sessionId = statusQuery.data?.sessionId ?? null;
  const setupCompleted = statusQuery.data?.completed ?? false;

  useSetupRouteTransition({ sessionId, completed: setupCompleted });

  const { sourceControlSetup, connectedProviderCount } =
    useSetupSourceControlStatus(enabled);
  useSetupSourceControlMilestoneEffect({
    enabled: enabled && Boolean(sessionId),
    connectedProviderCount,
  });
  const notifyRecommendationChoice = useSetupRecommendationNotifications();

  const messagesQuery = useQuery(
    trpc.fastSessions.messages.queryOptions(
      { sessionId: sessionId! },
      {
        enabled: Boolean(sessionId),
        // The SSE stream in the transcript keeps rows fresh; this query only
        // seeds the initial transcript snapshot.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
      },
    ),
  );
  const sessionTasksQuery = useQuery(
    trpc.fastSessions.tasks.queryOptions(
      { sessionId: sessionId! },
      { enabled: Boolean(sessionId) },
    ),
  );

  const sourceControlConnected = connectedProviderCount > 0;

  if (!enabled) {
    return null;
  }

  const sessionIdValue = sessionId;
  const initialMessages = (messagesQuery.data?.messages ??
    []) as unknown as FastSessionMessage[];
  const hasOlderMessages = messagesQuery.data?.hasOlderMessages ?? false;
  const timelineExtras = (
    <div className="space-y-4">
      {sessionTasksQuery.data && sessionTasksQuery.data.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-3 text-sm font-medium">Launched tasks</p>
          <ul className="space-y-2">
            {sessionTasksQuery.data.map((task) => (
              <li key={task.taskId} className="text-sm">
                <a
                  className="underline decoration-border underline-offset-2 hover:decoration-foreground"
                  href={`/task/${task.taskId}`}
                >
                  {task.title || task.taskId}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {sourceControlConnected ? (
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
      ) : null}
    </div>
  );

  return (
    // Break out of the centered setup column: the conversational workspace is
    // a full-height two-pane surface, not a narrow wizard step.
    <div className="relative left-[calc(-50vw+50%)] flex h-[calc(var(--effective-viewport-height)-8rem)] w-screen flex-col gap-4 px-2 lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background">
        {sessionIdValue ? (
          <FastSessionTranscript
            sessionId={sessionIdValue}
            initialMessages={initialMessages}
            hasOlderMessages={hasOlderMessages}
            canReply
            initialTitle="Set up Roomote."
            fallbackTitle="Set up Roomote."
            timelineExtras={timelineExtras}
          />
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            Preparing your setup session…
          </div>
        )}
      </div>
      {sourceControlSetup && !setupCompleted ? (
        <div className="shrink-0 overflow-y-auto lg:w-[24rem]">
          <SetupSourceControlPanelSurface
            sourceControlSetup={sourceControlSetup}
          />
        </div>
      ) : null}
    </div>
  );
}
