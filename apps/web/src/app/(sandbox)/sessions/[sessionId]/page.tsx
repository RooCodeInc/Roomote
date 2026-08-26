import Link from 'next/link';
import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';
import { WorkspaceHeader, WorkspaceSurface } from '@/components/layout';
import {
  ArrowLeft,
  Badge,
  BotMessageSquare,
  Button,
  EmptyState,
} from '@/components/system';

import { FastSessionTranscript } from './FastSessionTranscript';

function IdentityRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ph-no-capture min-w-0 break-all">{value}</dd>
    </div>
  );
}

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
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Back to sessions"
          >
            <Link href="/sessions">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="ph-no-capture truncate text-sm font-medium">
              {session.conversationId}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              Fast OpenCode session
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Badge variant="outline" className="capitalize">
              {session.surface}
            </Badge>
            <Badge
              variant={session.openCodeSessionId ? 'success' : 'secondary'}
            >
              {session.openCodeSessionId ? 'Native context' : 'Stored history'}
            </Badge>
          </div>
        </WorkspaceHeader>

        <FastSessionTranscript
          messages={session.messages}
          footer={
            <div className="space-y-8 border-t border-border/60 pt-6 pb-2">
              {session.messages.length === 0 ? (
                <EmptyState
                  icon={<BotMessageSquare className="size-6" />}
                  title="No canonical messages"
                  description="This session predates canonical Fast message persistence or has not recorded a new turn yet."
                  containerClassName="py-10"
                />
              ) : null}

              {session.linkedTasks.length > 0 ? (
                <section aria-labelledby="delegated-tasks-heading">
                  <h2 id="delegated-tasks-heading" className="font-semibold">
                    Delegated tasks
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Tasks launched from this Fast conversation.
                  </p>
                  <div className="mt-3 divide-y divide-border">
                    {session.linkedTasks.map((task) => (
                      <Link
                        key={task.taskId}
                        href={`/task/${task.taskId}`}
                        className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:underline"
                      >
                        <span className="min-w-0 truncate">{task.title}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          {task.taskPhase ? (
                            <Badge variant="outline">{task.taskPhase}</Badge>
                          ) : null}
                          {task.status ? (
                            <Badge variant="secondary">{task.status}</Badge>
                          ) : null}
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}

              <section
                aria-labelledby="session-context-heading"
                className="border-t border-border/60 pt-6"
              >
                <h2 id="session-context-heading" className="font-semibold">
                  Session context
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Identity and persistence details for this Fast conversation.
                </p>
                <dl className="mt-4 space-y-3">
                  <IdentityRow label="Session ID" value={session.id} />
                  <IdentityRow label="Surface" value={session.surface} />
                  <IdentityRow label="Workspace" value={session.workspaceId} />
                  <IdentityRow
                    label="Conversation"
                    value={session.conversationId}
                  />
                  {authorizedUser.isAdmin ? (
                    <IdentityRow
                      label="Owner"
                      value={session.ownerName ?? session.ownerEmail}
                    />
                  ) : null}
                  <IdentityRow
                    label="Reply target"
                    value={
                      session.replyTargetVerified ? 'Verified' : 'Unverified'
                    }
                  />
                  {session.currentReplyChannelId ? (
                    <IdentityRow
                      label="Reply channel"
                      value={session.currentReplyChannelId}
                    />
                  ) : null}
                  {session.currentReplyThreadId ? (
                    <IdentityRow
                      label="Reply thread"
                      value={session.currentReplyThreadId}
                    />
                  ) : null}
                  {session.openCodeSessionId ? (
                    <IdentityRow
                      label="OpenCode session"
                      value={session.openCodeSessionId}
                    />
                  ) : null}
                  <IdentityRow
                    label="Messages stored"
                    value={session.messageCount.toLocaleString()}
                  />
                  <IdentityRow
                    label="Created"
                    value={session.createdAt.toISOString()}
                  />
                  <IdentityRow
                    label="Last activity"
                    value={session.updatedAt.toISOString()}
                  />
                </dl>
              </section>

              <section className="border-t border-border/60 pt-6 text-sm">
                <h2 className="font-semibold">
                  OpenCode workspace details unavailable
                </h2>
                <p className="mt-1 text-muted-foreground">
                  Fast now persists canonical visible messages, native tool
                  calls and results, and OpenCode session relationships. Raw
                  OpenCode reasoning, child-session event streams, conversation
                  lifecycle status, artifacts, repository state, logs, terminal
                  access, and preview endpoints are not exposed by the current
                  Fast runtime.
                </p>
                <p className="mt-3">
                  compatibilityMessages remains a write-only N-1 rollback path
                  during this release. Canonical transcript reads do not
                  backfill or fall back to legacy history.
                </p>
              </section>
            </div>
          }
        />
      </div>
    </WorkspaceSurface>
  );
}
