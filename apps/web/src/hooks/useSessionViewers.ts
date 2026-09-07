'use client';

import { useQuery } from '@tanstack/react-query';

export type SessionViewer = {
  id: string;
  name: string;
  email: string;
  imageUrl: string;
};

export function useSessionViewers(sessionId: string) {
  const { data, isError } = useQuery({
    queryKey: ['session-viewers', sessionId],
    queryFn: async ({ signal }): Promise<SessionViewer[]> => {
      const response = await fetch(`/api/sessions/${sessionId}/presence`, {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Failed to load session viewers');
      return response.json();
    },
    refetchInterval: 5_000,
    retry: false,
    gcTime: 0,
  });

  return isError ? [] : (data ?? []);
}
