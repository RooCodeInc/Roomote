'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';

import { getUserDisplayName } from '@/lib';
import {
  Avatar,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';

type FastSessionCardSession = {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  title: string | null;
  surface: string;
  conversationId: string;
  updatedAt: Date;
};

export function FastSessionCard({
  session,
  showOwner,
}: {
  session: FastSessionCardSession;
  showOwner: boolean;
}) {
  const router = useRouter();
  const ownerDisplayName =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Someone';
  const activityDate = new Date(session.updatedAt);
  const title =
    session.title ??
    (session.surface === 'web' ? 'Session' : session.conversationId);

  return (
    <div
      className="ph-no-capture relative flex w-full cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-accent-foreground/10"
      onClick={() => router.push(`/sessions/${session.id}`)}
    >
      {/* Avatar */}
      <div className="relative mt-1 flex h-8 w-12 shrink-0 justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Avatar
              imageUrl={session.ownerImageUrl}
              name={ownerDisplayName}
              email={session.ownerEmail ?? undefined}
              size="md"
              className="ring-1 ring-background"
              alt={ownerDisplayName}
            />
          </TooltipTrigger>
          <TooltipContent>
            <p>{ownerDisplayName}</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground/75 md:items-center">
          <div className="flex flex-wrap items-center gap-1 text-nowrap">
            <span className="ph-no-capture">
              {showOwner ? ownerDisplayName : 'You'}
            </span>
            <span>started a session</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default whitespace-nowrap">
                {formatDistanceToNow(activityDate, { addSuffix: true })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{activityDate.toLocaleString()}</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Title */}
        <Link
          href={`/sessions/${session.id}`}
          className="group block"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="ph-no-capture mt-1 mb-2 line-clamp-2 text-lg leading-tight text-foreground group-hover:underline">
            {title}
          </p>
        </Link>
      </div>
    </div>
  );
}
