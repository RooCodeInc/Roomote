import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';
import { WorkspaceHeader } from '@/components/layout';

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

  const sessionInfo: SessionInfo = {
    id: session.id,
    ownerName: session.ownerName,
    ownerEmail: session.ownerEmail,
    ownerImageUrl: session.ownerImageUrl,
    surface: session.surface,
    workspaceId: session.workspaceId,
    conversationId: session.conversationId,
    openCodeSessionId: session.openCodeSessionId,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };

  return (
    <SessionWorkspace session={sessionInfo}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background">
        <WorkspaceHeader contentClassName="flex-row items-center gap-3">
          <h1 className="ph-no-capture min-w-0 flex-1 truncate text-sm font-medium">
            {session.title ??
              (session.surface === 'web' ? 'Session' : session.conversationId)}
          </h1>
        </WorkspaceHeader>

        <FastSessionTranscript
          sessionId={session.id}
          initialMessages={session.messages}
          hasOlderMessages={session.hasOlderMessages}
          canReply={session.surface === 'web'}
        />
      </div>
    </SessionWorkspace>
  );
}
