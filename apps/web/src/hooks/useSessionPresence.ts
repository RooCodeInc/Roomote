'use client';

import { useEffect } from 'react';

const HEARTBEAT_INTERVAL_MS = 10_000;

export function useSessionPresence(sessionId: string) {
  useEffect(() => {
    const clientId = crypto.randomUUID();
    const url = `/api/sessions/${sessionId}/presence`;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let active = false;

    const send = (method: 'POST' | 'DELETE') => {
      void fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const disconnect = () => {
      if (!active) return;
      active = false;
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
      send('POST');
      heartbeatInterval = setInterval(
        () => send('POST'),
        HEARTBEAT_INTERVAL_MS,
      );
    };

    syncPresence();
    window.addEventListener('focus', syncPresence);
    window.addEventListener('blur', disconnect);
    window.addEventListener('pagehide', disconnect);
    document.addEventListener('visibilitychange', syncPresence);

    return () => {
      window.removeEventListener('focus', syncPresence);
      window.removeEventListener('blur', disconnect);
      window.removeEventListener('pagehide', disconnect);
      document.removeEventListener('visibilitychange', syncPresence);
      disconnect();
    };
  }, [sessionId]);
}
