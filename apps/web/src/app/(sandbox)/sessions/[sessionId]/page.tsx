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
import { SessionViewers } from '@/components/sessions/SessionViewers';
import { ServiceCredentials } from '@/components/sessions/ServiceCredentials';
import { PrivateSessionIcon } from '@/components/sessions/PrivateSessionIcon';

import { hasVoiceAutostartFlag } from '@/lib/voice-autostart';
import { FastSessionTranscript } from './FastSessionTranscript';
import { SessionTaskTimeline } from './SessionTaskTimeline';
import {
  SessionHeaderPullRequests,
  SessionWorkspace,
  type SessionInfo,
} from './SessionWorkspace';
import { SessionReadTracker } from './SessionReadTracker';
import {
  SESSION_HEADER_CONTENT_CLASS_NAME,
  SESSION_HEADER_TITLE_CLASS_NAME,
} from './session-header-layout';
import { LiveSessionTitle } from './LiveSessionTitle';

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
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
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
  searchParams,
}: SessionDetailPageProps) {
  const { sessionId } = await params;
  const sessionPageDataPromise = getSessionPageData(sessionId);
  const modelEnvPromise: Promise<Record<string, string>> =
    resolveEffectiveModelRuntimeEnv().catch(() => ({}));
  const [
    { authorizedUser, unifiedSession, session },
    modelEnv,
    resolvedParams,
  ] = await Promise.all([
    sessionPageDataPromise,
    modelEnvPromise,
    searchParams,
  ]);
  const autoStartVoice = hasVoiceAutostartFlag(resolvedParams);
  // The chip's "default" must reflect what Fast actually runs with: the
  // deployment's orchestration model, not the task launch default.
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
      canDelete:
        unifiedSession.privacy === 'private'
          ? unifiedSession.privateOwnerUserId === authorizedUser.userId
          : authorizedUser.isAdmin ||
            unifiedSession.ownerUserId === authorizedUser.userId,
      ownerName: unifiedSession.ownerName,
      ownerEmail: unifiedSession.ownerEmail,
      ownerImageUrl: unifiedSession.ownerImageUrl,
      privacy: unifiedSession.privacy,
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
      goal: unifiedSession.goal,
      tasks: unifiedSession.tasks,
      artifacts: unifiedSession.artifacts,
    };
    return (
      <SessionWorkspace session={sessionInfo}>
        <SessionReadTracker sessionId={unifiedSession.id} />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
          {session ? (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <FastSessionTranscript
                  sessionId={session.id}
                  secretSessionId={
                    unifiedSession.ownerUserId === authorizedUser.userId
                      ? unifiedSession.id
                      : undefined
                  }
                  initialMessages={session.messages}
                  hasOlderMessages={session.hasOlderMessages}
                  canReply
                  initialTitle={unifiedSession.title}
                  fallbackTitle={unifiedSession.title}
                  sessionModel={session.model}
                  sessionReasoningEffort={session.reasoningEffort}
                  defaultModelId={defaultModelId}
                  defaultReasoningEffort={defaultReasoningEffort}
                  autoStartVoice={autoStartVoice}
                  privateSession={unifiedSession.privacy === 'private'}
                  sessionGoal={unifiedSession.goal}
                  canRenameTitle={sessionInfo.canDelete}
                  titleSessionId={unifiedSession.id}
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
                  headerExtras={
                    <SessionHeaderPullRequests key="session-pull-requests" />
                  }
                  headerActions={
                    <SessionViewers
                      key="session-viewers"
                      sessionId={unifiedSession.id}
                    />
                  }
                />
              </div>
            </div>
          ) : (
            <>
              <WorkspaceHeader
                className="py-4"
                contentClassName={`${SESSION_HEADER_CONTENT_CLASS_NAME} !flex-nowrap`}
                actions={
                  <>
                    {unifiedSession.ownerUserId === authorizedUser.userId ? (
                      <ServiceCredentials sessionId={unifiedSession.id} />
                    ) : null}
                    <SessionViewers sessionId={unifiedSession.id} />
                  </>
                }
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <LiveSessionTitle
                    sessionId={unifiedSession.id}
                    initialTitle={unifiedSession.title}
                    canRename={sessionInfo.canDelete}
                    className={SESSION_HEADER_TITLE_CLASS_NAME}
                  />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-xs text-muted-foreground">
                    {unifiedSession.privacy === 'private' ? (
                      <PrivateSessionIcon className="text-accent-foreground" />
                    ) : null}
                    <SessionHeaderPullRequests />
                  </div>
                </div>
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
    canDelete: false,
    ownerName: session.ownerName,
    ownerEmail: session.ownerEmail,
    ownerImageUrl: session.ownerImageUrl,
    privacy: session.privacy,
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
    goal: null,
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
          autoStartVoice={autoStartVoice}
          privateSession={session.privacy === 'private'}
          {...(session.userId
            ? {
                owner: {
                  userId: session.userId,
                  name: session.ownerName,
                  email: session.ownerEmail,
                  imageUrl: session.ownerImageUrl,
                },
              }
            : {})}
        />
      </div>
    </SessionWorkspace>
  );
}
