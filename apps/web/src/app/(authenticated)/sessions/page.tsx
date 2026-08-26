import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessions } from '@/lib/server/fast-sessions';
import {
  Badge,
  BotMessageSquare,
  Empty,
  EmptyDescription,
  EmptyHeader,
  MessagesSquare,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';

function sessionContextLabel(openCodeSessionId: string | null) {
  return openCodeSessionId ? 'Native context' : 'Stored history';
}

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
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
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
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No Fast sessions yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="mx-auto w-full max-w-4xl divide-y divide-card">
              {sessions.map((session) => {
                const activityDate = new Date(session.updatedAt);

                return (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.id}`}
                    className="group flex w-full items-start gap-3 p-4 transition-colors hover:bg-accent-foreground/10"
                  >
                    <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
                      <BotMessageSquare className="size-4 text-muted-foreground" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground/75 md:items-center">
                        <span className="capitalize">{session.surface}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default whitespace-nowrap">
                              {formatDistanceToNow(activityDate, {
                                addSuffix: true,
                              })}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{activityDate.toISOString()}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="ph-no-capture my-1 line-clamp-2 text-lg leading-tight text-foreground group-hover:underline">
                        {session.title ??
                          (session.surface === 'web'
                            ? 'Fast session'
                            : session.conversationId)}
                      </p>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="ph-no-capture truncate">
                          Workspace {session.workspaceId}
                        </span>
                        {authorizedUser.isAdmin ? (
                          <span className="ph-no-capture truncate">
                            {session.ownerName ?? session.ownerEmail}
                          </span>
                        ) : null}
                        <span>
                          {session.messageCount}{' '}
                          {session.messageCount === 1 ? 'message' : 'messages'}
                        </span>
                        <Badge variant="outline">
                          {sessionContextLabel(session.openCodeSessionId)}
                        </Badge>
                        <Badge
                          variant={
                            session.replyTargetVerified ? 'success' : 'warning'
                          }
                        >
                          {session.replyTargetVerified
                            ? 'Reply verified'
                            : 'Reply unverified'}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                );
              })}
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
