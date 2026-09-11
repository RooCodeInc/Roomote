'use client';

import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function usePreviewVoice() {
  const trpc = useTRPC();
  return useMutation(trpc.voice.preview.mutationOptions());
}
