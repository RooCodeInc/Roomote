import Link from 'next/link';
import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';
import { getFastSessionById } from '@/lib/server/fast-sessions';
import {
  ArrowLeft,
  Badge,
  BotMessageSquare,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@/components/system';

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
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="flex shrink-0 items-center overflow-hidden border-b-2 border-card py-3 @container">
        <div className="relative mx-auto flex min-w-0 w-full max-w-4xl flex-1 items-center gap-3 px-4">
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
              Fast session
            </p>
          </div>
          <Badge variant="outline" className="capitalize">
            {session.surface}
          </Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Session context</CardTitle>
              <CardDescription>
                Identity and persistence details for this Fast conversation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
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
                  label="Context"
                  value={
                    session.openCodeSessionId
                      ? 'Native OpenCode context recorded'
                      : 'Stored message history only'
                  }
                />
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
                <IdentityRow
                  label="Messages"
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
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <EmptyState
                icon={<BotMessageSquare className="size-6" />}
                title="Session details are coming soon"
                description="Conversation history and delegated task context will appear here in a future update."
                containerClassName="py-10"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
