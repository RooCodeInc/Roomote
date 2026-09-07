'use client';

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
        return (
          <BasicTooltip key={viewer.id} content={label}>
            <Avatar
              imageUrl={viewer.imageUrl}
              name={viewer.name}
              email={viewer.email}
              alt={label}
              size="sm"
              tabIndex={0}
              className="transition-[margin] duration-200 motion-reduce:transition-none hover:z-10 focus:z-10"
              style={{
                marginLeft: index === 0 ? 0 : viewers.length > 3 ? -4 : 2,
              }}
            />
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
