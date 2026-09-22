'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useSessionTitlePropagation(
  title: string | null | undefined,
  initialTitle: string | null | undefined = title,
) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const previousTitle = useRef(initialTitle);

  useEffect(() => {
    if (title === previousTitle.current) return;
    previousTitle.current = title;
    void queryClient.invalidateQueries({
      queryKey: trpc.sessions.list.queryKey(),
    });
  }, [queryClient, title, trpc]);
}
