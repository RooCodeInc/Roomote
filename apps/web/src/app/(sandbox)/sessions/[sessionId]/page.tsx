import { notFound } from 'next/navigation';

import { resolveEffectiveModelRuntimeEnv } from '@roomote/db/server';
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';

import { FastSessionTranscript } from './FastSessionTranscript';
import { SessionWorkspace, type SessionInfo } from './SessionWorkspace';

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

  const session = await getFastSessionById(authorizedUser, sessionId);
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
    inferenceCostMicroUsd: session.inferenceCostMicroUsd,
    createdAt: session.createdAt,
  };

  return (
    <SessionWorkspace session={sessionInfo}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
        <FastSessionTranscript
          sessionId={session.id}
          initialMessages={session.messages}
          hasOlderMessages={session.hasOlderMessages}
          canReply={session.surface === 'web'}
          initialTitle={session.title}
          fallbackTitle={
            session.surface === 'web' ? 'Session' : session.conversationId
          }
          sessionModel={session.model}
          sessionReasoningEffort={session.reasoningEffort}
          defaultModelId={defaultModelId}
          defaultReasoningEffort={defaultReasoningEffort}
        />
      </div>
    </SessionWorkspace>
  );
}
