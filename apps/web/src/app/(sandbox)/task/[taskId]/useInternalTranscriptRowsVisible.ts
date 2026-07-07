'use client';

import { useShowDebugUI } from '@/hooks/useShowDebugUI';

export function useInternalTranscriptRowsVisible(): boolean {
  const { isDebugUIVisible } = useShowDebugUI();

  return isDebugUIVisible;
}
