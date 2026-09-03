import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { resolveEffectiveModelRuntimeEnv } from '@roomote/db/server';
import {
  getTextFromContentBlocks,
  PRODUCT_NAME,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { truncatePageTitle } from '@/lib/page-title';
import {
  getFastSessionById,
  getFastSessionTasks,
} from '@/lib/server/fast-sessions';
import { getSessionByIdCommand } from '@/trpc/commands/sessions';
import { WorkspaceHeader } from '@/components/layout';

import { findDeploymentSetupSessionId } from '@/trpc/commands/setup/setup-session';
import { FastSessionTranscript } from './FastSessionTranscript';
import { SessionTaskTimeline } from './SessionTaskTimeline';
import {
  SessionHeaderPullRequests,
  SessionWorkspace,
  type SessionInfo,
} from './SessionWorkspace';
import { SessionReadTracker } from './SessionReadTracker';
import { SetupAutomationRecommendationsCard } from './setup/SetupAutomationRecommendationsCard';
import { SetupSandboxCard } from './setup/SetupSandboxCard';
import { SetupSessionSourceControlCard } from './setup/SetupSourceControlCard';
import {
  SESSION_HEADER_CONTENT_CLASS_NAME,
  SESSION_HEADER_TITLE_CLASS_NAME,
} from './session-header-layout';

const getSessionPageData = cache(async (sessionId: string) => {
  const authorizedUser = await authorize();
  if (!authorizedUser.success) {
    notFound();
  }
  // Both lookup columns are uuid; a garbage route param would otherwise throw
  // 22P02 in Postgres instead of 404ing.
  if (!z.string().uuid().safeParse(sessionId).success) {
    notFound();
  }

  // Old links may carry a fast-conversation id whose session row hasn't been
  // backfilled yet; getSessionByIdCommand falls back by fastConversationId,
  // and the fast lookup below covers a conversation with no session row.
  const unifiedSession = await getSessionByIdCommand(authorizedUser, sessionId);
  const session = unifiedSession?.fastConversationId
    ? await getFastSessionById(
        authorizedUser,
        unifiedSession.fastConversationId,
      )
    : unifiedSession
      ? null
      : await getFastSessionById(authorizedUser, sessionId);

  if (!unifiedSession && !session) {
    notFound();
  }

  return { authorizedUser, unifiedSession, session };
});

type SessionDetailPageProps = {
  params: Promise<{ sessionId: string }>;
};

export async function generateMetadata({
  params,
}: SessionDetailPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const { unifiedSession, session } = await getSessionPageData(sessionId);
  const initialUserMessage = session?.messages.find(
    (message) => message.role === 'user',
  );
  const fallbackTitle =
    getTextFromContentBlocks(initialUserMessage?.contentBlocks ?? [])?.trim() ||
    'New session';
  const title = truncatePageTitle(
    unifiedSession?.title ?? session?.title ?? fallbackTitle,
  );

  return { title: `${title} | ${PRODUCT_NAME}` };
}

export default async function SessionDetailPage({
  params,
}: SessionDetailPageProps) {
  const { sessionId } = await params;
  const { authorizedUser, unifiedSession, session } =
    await getSessionPageData(sessionId);
  // The chip's "default" must reflect what Fast actually runs with: the
  // deployment's orchestration model, not the task launch default.
  const modelEnv: Record<string, string> =
    await resolveEffectiveModelRuntimeEnv().catch(() => ({}));
  const defaultModelId =
    modelEnv.R_ORCHESTRATION_MODEL || modelEnv.R_MODEL || null;
  const rawDefaultEffort = modelEnv.R_ORCHESTRATION_MODEL_REASONING_EFFORT;
  const defaultReasoningEffort = REASONING_EFFORT_VALUES.includes(
    rawDefaultEffort as ReasoningEffort,
  )
    ? (rawDefaultEffort as ReasoningEffort)
    : null;

  if (unifiedSession) {
    const sessionInfo: SessionInfo = {
      id: unifiedSession.id,
      ownerName: unifiedSession.ownerName,
      ownerEmail: unifiedSession.ownerEmail,
      ownerImageUrl: unifiedSession.ownerImageUrl,
      surface: unifiedSession.sourceSurface,
      model: session?.model ?? defaultModelId,
      reasoningEffort: session?.reasoningEffort ?? defaultReasoningEffort,
      inferenceCostMicroUsd: unifiedSession.inferenceCostMicroUsd,
      inferenceCostBreakdown: {
        directInferenceCostMicroUsd: unifiedSession.directInferenceCostMicroUsd,
        tasks: unifiedSession.tasks.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          inferenceCostMicroUsd: task.inferenceCostMicroUsd,
        })),
      },
      createdAt: unifiedSession.createdAt,
      status: unifiedSession.status,
      tasks: unifiedSession.tasks,
      artifacts: unifiedSession.artifacts,
    };
    // The setup session keeps its inline automation-recommendations card on
    // its normal route after activation: recommendations are optional and
    // must not interrupt activation, so they surface here once ready.
    const isSetupSession =
      authorizedUser.isAdmin &&
      unifiedSession.id === (await findDeploymentSetupSessionId());
    const setupTimelineExtras = isSetupSession ? (
      <div className="space-y-3">
        <SetupSessionSourceControlCard sessionId={unifiedSession.id} />
        <SetupSandboxCard />
        <SetupAutomationRecommendationsCard sessionId={unifiedSession.id} />
      </div>
    ) : null;
    return (
      <SessionWorkspace session={sessionInfo}>
        <SessionReadTracker sessionId={unifiedSession.id} />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
          {session ? (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <FastSessionTranscript
                  sessionId={session.id}
                  initialMessages={session.messages}
                  hasOlderMessages={session.hasOlderMessages}
                  canReply
                  initialTitle={unifiedSession.title}
                  fallbackTitle={unifiedSession.title}
                  sessionModel={session.model}
                  sessionReasoningEffort={session.reasoningEffort}
                  defaultModelId={defaultModelId}
                  defaultReasoningEffort={defaultReasoningEffort}
                  {...(unifiedSession.ownerUserId
                    ? {
                        owner: {
                          userId: unifiedSession.ownerUserId,
                          name: unifiedSession.ownerName,
                          email: unifiedSession.ownerEmail,
                          imageUrl: unifiedSession.ownerImageUrl,
                        },
                      }
                    : {})}
                  headerExtras={<SessionHeaderPullRequests />}
                  {...(isSetupSession
                    ? { timelineExtras: setupTimelineExtras }
                    : {})}
                />
              </div>
            </div>
          ) : (
            <>
              <WorkspaceHeader
                className="py-4"
                contentClassName={SESSION_HEADER_CONTENT_CLASS_NAME}
              >
                <h1 className={SESSION_HEADER_TITLE_CLASS_NAME}>
                  {unifiedSession.title}
                </h1>
                <SessionHeaderPullRequests />
              </WorkspaceHeader>
              <SessionTaskTimeline
                sessionId={unifiedSession.id}
                initialTasks={unifiedSession.tasks}
              />
            </>
          )}
        </div>
      </SessionWorkspace>
    );
  }
  if (!session) notFound();

  const fastTasks =
    (await getFastSessionTasks(authorizedUser, session.id)) ?? [];
  const directInferenceCostMicroUsd =
    session.directInferenceCostMicroUsd ?? session.inferenceCostMicroUsd ?? 0;
  const inferenceCostMicroUsd = fastTasks.reduce(
    (total, task) => total + task.inferenceCostMicroUsd,
    directInferenceCostMicroUsd,
  );

  const sessionInfo: SessionInfo = {
    id: session.id,
    ownerName: session.ownerName,
    ownerEmail: session.ownerEmail,
    ownerImageUrl: session.ownerImageUrl,
    surface: session.surface,
    model: session.model ?? defaultModelId,
    reasoningEffort: session.reasoningEffort ?? defaultReasoningEffort,
    inferenceCostMicroUsd,
    inferenceCostBreakdown: {
      directInferenceCostMicroUsd,
      tasks: fastTasks,
    },
    createdAt: session.createdAt,
    status: null,
    tasks: [],
    artifacts: [],
    taskSource: 'fast',
    taskCards: fastTasks,
  };
  const initialUserMessage = session.messages.find(
    (message) => message.role === 'user',
  );
  const fallbackTitle =
    getTextFromContentBlocks(initialUserMessage?.contentBlocks ?? [])?.trim() ||
    'New session';

  return (
    <SessionWorkspace session={sessionInfo}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
        <FastSessionTranscript
          sessionId={session.id}
          initialMessages={session.messages}
          hasOlderMessages={session.hasOlderMessages}
          canReply
          initialTitle={session.title}
          fallbackTitle={fallbackTitle}
          sessionModel={session.model}
          sessionReasoningEffort={session.reasoningEffort}
          defaultModelId={defaultModelId}
          defaultReasoningEffort={defaultReasoningEffort}
          owner={{
            userId: session.userId,
            name: session.ownerName,
            email: session.ownerEmail,
            imageUrl: session.ownerImageUrl,
          }}
        />
      </div>
    </SessionWorkspace>
  );
}
