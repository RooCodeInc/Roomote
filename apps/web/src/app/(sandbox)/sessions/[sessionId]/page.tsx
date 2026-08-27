import { notFound } from 'next/navigation';

import { resolveEffectiveModelRuntimeEnv } from '@roomote/db/server';
import {
  getTextFromContentBlocks,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';
import { getSessionByIdCommand } from '@/trpc/commands/sessions';
import { Badge } from '@/components/system';
import { WorkspaceHeader } from '@/components/layout';

import { FastSessionTranscript } from './FastSessionTranscript';
import { SessionWorkspace, type SessionInfo } from './SessionWorkspace';
import { SessionTaskCards } from './SessionTaskCards';
import { SessionReadTracker } from './SessionReadTracker';

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const [{ sessionId }, authorizedUser] = await Promise.all([
    params,
    authorize(),
  ]);
  if (!authorizedUser.success) {
    notFound();
  }

  const unifiedSession = await getSessionByIdCommand(authorizedUser, sessionId);
  const session = unifiedSession?.fastConversationId
    ? await getFastSessionById(
        authorizedUser,
        unifiedSession.fastConversationId,
      )
    : unifiedSession
      ? null
      : await getFastSessionById(authorizedUser, sessionId);
  if (unifiedSession) {
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
    const sessionInfo: SessionInfo = {
      id: unifiedSession.id,
      ownerName: unifiedSession.ownerName,
      ownerEmail: unifiedSession.ownerEmail,
      ownerImageUrl: unifiedSession.ownerImageUrl,
      surface: unifiedSession.sourceSurface,
      model: session?.model ?? defaultModelId,
      reasoningEffort: session?.reasoningEffort ?? defaultReasoningEffort,
      inferenceCostMicroUsd: unifiedSession.inferenceCostMicroUsd,
      createdAt: unifiedSession.createdAt,
      status: unifiedSession.status,
      tasks: unifiedSession.tasks,
    };
    const statusVariant =
      unifiedSession.status === 'active'
        ? 'success'
        : unifiedSession.status === 'needs_input'
          ? 'warning'
          : unifiedSession.status === 'blocked'
            ? 'destructive'
            : 'secondary';
    const taskCards = (
      <SessionTaskCards
        sessionId={unifiedSession.id}
        tasks={unifiedSession.tasks}
      />
    );

    return (
      <SessionWorkspace session={sessionInfo}>
        <SessionReadTracker sessionId={unifiedSession.id} />
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
          {session ? (
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
              headerExtras={
                <Badge variant={statusVariant}>
                  {unifiedSession.status.replace('_', ' ')}
                </Badge>
              }
              timelineExtras={taskCards}
            />
          ) : (
            <>
              <WorkspaceHeader
                className="py-4"
                contentClassName="flex-row items-center gap-3"
              >
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
                  {unifiedSession.title}
                </h1>
                <Badge variant={statusVariant}>
                  {unifiedSession.status.replace('_', ' ')}
                </Badge>
              </WorkspaceHeader>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto max-w-4xl">{taskCards}</div>
              </div>
            </>
          )}
        </div>
      </SessionWorkspace>
    );
  }
  if (!session) {
    notFound();
  }

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

  const sessionInfo: SessionInfo = {
    id: session.id,
    ownerName: session.ownerName,
    ownerEmail: session.ownerEmail,
    ownerImageUrl: session.ownerImageUrl,
    surface: session.surface,
    model: session.model ?? defaultModelId,
    reasoningEffort: session.reasoningEffort ?? defaultReasoningEffort,
    inferenceCostMicroUsd: session.inferenceCostMicroUsd,
    createdAt: session.createdAt,
    status: null,
    tasks: [],
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
        />
      </div>
    </SessionWorkspace>
  );
}
