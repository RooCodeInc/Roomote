'use client';

import Link from 'next/link';

import { Avatar, BasicTooltip } from '@/components/system';
import {
  useSessionViewers,
  type SessionViewer,
} from '@/hooks/useSessionViewers';
import { useAuthorizedUser } from '@/hooks/useUser';

export function SessionViewerAvatars({
  viewers,
}: {
  viewers: SessionViewer[];
}) {
  if (viewers.length === 0) return null;

  return (
    <div
      className="ph-no-capture ml-auto flex shrink-0 items-center"
      role="group"
      aria-label="Current session viewers"
    >
      {viewers.map((viewer, index) => {
        const label = `${viewer.name?.trim() || viewer.email.trim()} is viewing`;
        const identity = viewer.name?.trim() || viewer.email.trim();
        return (
          <BasicTooltip key={viewer.id} content={label}>
            <Link
              href={{ pathname: '/sessions', query: { user: viewer.id } }}
              aria-label={`View sessions by ${identity}`}
              className="cursor-pointer transition-[margin] duration-200 motion-reduce:transition-none hover:z-10 focus:z-10"
              style={{
                marginLeft: index === 0 ? 0 : viewers.length > 3 ? -4 : 2,
              }}
            >
              <Avatar
                imageUrl={viewer.imageUrl}
                name={viewer.name}
                email={viewer.email}
                alt={label}
                size="sm"
              />
            </Link>
          </BasicTooltip>
        );
      })}
    </div>
  );
}

export function SessionViewers({ sessionId }: { sessionId: string }) {
  const { userId } = useAuthorizedUser();
  const viewers = useSessionViewers(sessionId);

  return (
    <SessionViewerAvatars
      viewers={viewers.filter((viewer) => viewer.id !== userId)}
    />
  );
}
