'use client';

import { Avatar, BasicTooltip } from '@/components/system';
import {
  useSessionViewers,
  type SessionViewer,
} from '@/hooks/useSessionViewers';

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
      {viewers.map((viewer, index) => (
        <BasicTooltip
          key={viewer.id}
          content={
            <>
              <div>{viewer.name}</div>
              <div>{viewer.email}</div>
            </>
          }
        >
          <Avatar
            imageUrl={viewer.imageUrl}
            name={viewer.name}
            email={viewer.email}
            alt={`${viewer.name} (${viewer.email})`}
            size="sm"
            tabIndex={0}
            className="transition-[margin] duration-200 motion-reduce:transition-none hover:z-10 focus:z-10"
            style={{
              marginLeft: index === 0 ? 0 : viewers.length > 3 ? -4 : 2,
            }}
          />
        </BasicTooltip>
      ))}
    </div>
  );
}

export function SessionViewers({ sessionId }: { sessionId: string }) {
  return <SessionViewerAvatars viewers={useSessionViewers(sessionId)} />;
}
