'use client';

import { useCallback, useEffect, useRef } from 'react';

const HEARTBEAT_INTERVAL_MS = 10_000;

export function useSessionVoiceCallLease(sessionId: string, active: boolean) {
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const clientIdRef = useRef<string>(crypto.randomUUID());
  const requestChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!active) return;
    const url = `/api/sessions/${sessionId}/presence`;
    const body = JSON.stringify({
      clientId: clientIdRef.current,
      channel: 'voice',
    });
    const send = (method: 'POST' | 'DELETE') => {
      const request = requestChainRef.current.then(() =>
        fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).then(() => undefined),
      );
      requestChainRef.current = request.catch(() => undefined);
      return requestChainRef.current;
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
