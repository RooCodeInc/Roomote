import Link from 'next/link';
import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessions } from '@/lib/server/fast-sessions';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  MessagesSquare,
} from '@/components/system';

import { FastSessionCard } from './FastSessionCard';

export default async function SessionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ before?: string }>;
}) {
  const [authorizedUser, { before } = {}] = await Promise.all([
    authorize(),
    searchParams,
  ]);
  if (!authorizedUser.success) {
    notFound();
  }

  const { sessions, nextCursor } = await getFastSessions(authorizedUser, {
    before,
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="border-b-4 border-b-card bg-background p-4">
        <div className="flex items-center gap-3">
          <MessagesSquare className="size-5 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="font-medium">Fast sessions</h1>
            <p className="text-sm text-muted-foreground">
              Persisted conversations available to your account.
            </p>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No Fast sessions yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-card">
              {sessions.map((session) => (
                <FastSessionCard
                  key={session.id}
                  session={session}
                  showOwner={session.userId !== authorizedUser.userId}
                />
              ))}
              {nextCursor ? (
                <div className="flex justify-center p-4">
                  <Link
                    href={`/sessions?before=${encodeURIComponent(nextCursor)}`}
                    className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Show older sessions
                  </Link>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
