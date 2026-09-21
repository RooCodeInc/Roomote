'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import { EditableSessionTitle } from './EditableSessionTitle';
import { useSessionTitlePropagation } from './use-session-title-propagation';

export function LiveSessionTitle({
  sessionId,
  initialTitle,
  canRename,
  className,
}: {
  sessionId: string;
  initialTitle: string;
  canRename: boolean;
  className: string;
}) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.sessions.byId.queryOptions({ sessionId }));
  const title = data?.title ?? initialTitle;
  useSessionTitlePropagation(title, initialTitle);

  return (
    <EditableSessionTitle
      sessionId={sessionId}
      title={title}
      canRename={canRename}
      className={className}
    />
  );
}
