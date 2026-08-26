import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';
import { WorkspaceHeader, WorkspaceSurface } from '@/components/layout';

import { FastSessionTranscript } from './FastSessionTranscript';

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

  return (
    <WorkspaceSurface>
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
    </WorkspaceSurface>
  );
}
