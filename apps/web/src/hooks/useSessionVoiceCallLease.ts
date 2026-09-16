'use client';

import { useCallback, useEffect, useRef } from 'react';

const HEARTBEAT_INTERVAL_MS = 10_000;

export function useSessionVoiceCallLease(sessionId: string, active: boolean) {
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const clientIdRef = useRef<string>(crypto.randomUUID());
  const generationRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const url = `/api/sessions/${sessionId}/presence`;
    const send = (method: 'POST' | 'DELETE') => {
      const generation = ++generationRef.current;
      return fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          channel: 'voice',
          generation,
        }),
        keepalive: true,
      }).then(
        () => undefined,
        () => undefined,
      );
    };

    readyRef.current = send('POST');
    const heartbeatInterval = setInterval(
      () => void send('POST'),
      HEARTBEAT_INTERVAL_MS,
    );
    const disconnect = () => void send('DELETE');
    window.addEventListener('pagehide', disconnect);

    return () => {
      clearInterval(heartbeatInterval);
      window.removeEventListener('pagehide', disconnect);
      disconnect();
    };
  }, [active, sessionId]);

  return useCallback(() => readyRef.current, []);
}
