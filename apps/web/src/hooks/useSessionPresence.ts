'use client';

import { useEffect } from 'react';

const HEARTBEAT_INTERVAL_MS = 10_000;

export function useSessionPresence(
  sessionId: string,
  initialClientId?: string,
) {
  useEffect(() => {
    const clientId = initialClientId ?? crypto.randomUUID();
    const url = `/api/sessions/${sessionId}/presence`;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let active = false;
    let seeded = initialClientId !== undefined;

    const send = (method: 'POST' | 'DELETE') => {
      void fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const disconnect = () => {
      if (!active && !seeded) return;
      active = false;
      seeded = false;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
      send('DELETE');
    };
    const syncPresence = () => {
      const viewing =
        document.visibilityState === 'visible' && document.hasFocus();
      if (!viewing) {
        disconnect();
        return;
      }
      if (active) return;

      active = true;
      seeded = false;
      send('POST');
      heartbeatInterval = setInterval(
        () => send('POST'),
        HEARTBEAT_INTERVAL_MS,
      );
    };

    syncPresence();
    window.addEventListener('focus', syncPresence);
    window.addEventListener('pageshow', syncPresence);
    window.addEventListener('blur', disconnect);
    window.addEventListener('pagehide', disconnect);
    document.addEventListener('visibilitychange', syncPresence);

    return () => {
      window.removeEventListener('focus', syncPresence);
      window.removeEventListener('pageshow', syncPresence);
      window.removeEventListener('blur', disconnect);
      window.removeEventListener('pagehide', disconnect);
      document.removeEventListener('visibilitychange', syncPresence);
      disconnect();
    };
  }, [initialClientId, sessionId]);
}
