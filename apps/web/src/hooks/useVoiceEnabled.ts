'use client';

import { useEffect, useState } from 'react';

import { useTRPCClient } from '@/trpc/client';

/**
 * Whether the deployment has live voice configured (an OpenAI key for
 * transcription and speech). Resolves to false until the status query
 * answers, so voice controls never flash on a deployment without it.
 */
export function useVoiceEnabled(): boolean {
  const trpcClient = useTRPCClient();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    trpcClient.voice.status
      .query()
      .then((voiceStatus) => {
        if (!cancelled) {
          setEnabled(voiceStatus.enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trpcClient]);

  return enabled;
}
