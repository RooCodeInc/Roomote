'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Users,
} from '@/components/system';
import {
  useSessionViewers,
  type SessionViewer,
} from '@/hooks/useSessionViewers';
import { useAuthorizedUser } from '@/hooks/useUser';
import { SessionViewers } from './SessionViewers';

export function SessionParticipants({
  sessionId,
  surface = 'web',
}: {
  sessionId: string;
  surface?: string;
}) {
  return surface === 'web' ? (
    <WebSessionParticipants sessionId={sessionId} />
  ) : (
    <SessionViewers sessionId={sessionId} />
  );
}

function WebSessionParticipants({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const { userId } = useAuthorizedUser();
  const viewers = useSessionViewers(sessionId);
  const { data: contributors = [] } = useQuery({
    queryKey: ['session-contributors', sessionId],
    queryFn: async ({ signal }): Promise<SessionViewer[]> => {
      const response = await fetch(`/api/sessions/${sessionId}/participants`, {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Failed to load participants');
      return response.json();
    },
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  const currentIds = new Set(viewers.map((viewer) => viewer.id));
  const earlier = contributors.filter((viewer) => !currentIds.has(viewer.id));
  const identity = (viewer: SessionViewer) =>
    viewer.name?.trim() || viewer.email;
  const row = (viewer: SessionViewer) => (
    <li key={viewer.id} className="flex items-center gap-2 py-1.5">
      <Avatar
        imageUrl={viewer.imageUrl}
        name={viewer.name}
        email={viewer.email}
        size="xs"
      />
      <span className="min-w-0 truncate text-sm">
        {identity(viewer)}
        {viewer.id === userId ? ' (you)' : ''}
      </span>
    </li>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Session participants"
          className="gap-1 px-2"
        >
          {viewers.length ? (
            <span className="flex -space-x-1.5">
              {viewers.slice(0, 3).map((viewer) => (
                <Avatar
                  key={viewer.id}
                  imageUrl={viewer.imageUrl}
                  name={viewer.name}
                  email={viewer.email}
                  size="xs"
                  className="ring-2 ring-background"
                />
              ))}
            </span>
          ) : (
            <Users />
          )}
          {viewers.length > 3 ? (
            <span className="text-xs text-muted-foreground">
              +{viewers.length - 3}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-80 w-64 space-y-3 overflow-y-auto"
      >
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Viewing now
          </p>
          {viewers.length ? (
            <ul>{viewers.map(row)}</ul>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">
              No current viewers
            </p>
          )}
        </div>
        {earlier.length ? (
          <div className="border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              Earlier contributors
            </p>
            <ul>{earlier.map(row)}</ul>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
