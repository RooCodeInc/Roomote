'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserNotificationPermissionPrompt } from '@/components/notifications/BrowserNotificationPermissionPrompt';
import {
  claimBrowserNotification,
  getBrowserNotificationCapability,
  getBrowserNotificationPromptState,
  setBrowserNotificationPromptState,
  type BrowserNotificationCapability,
} from '@/lib/browser-notifications';

import { useBrowserNotificationsExperiment } from './useBrowserNotificationsExperiment';

type AttentionEvent = {
  notificationId: string;
  eventKey: string;
  mode: 'notify' | 'prompt';
  title: string;
  body: string;
  href: string;
  offerExpiresAt: string | null;
};

export function useSessionBrowserAttention(sessionId: string) {
  const { enabled } = useBrowserNotificationsExperiment();
  const [clientId] = useState(() => crypto.randomUUID());
  const [capability, setCapability] =
    useState<BrowserNotificationCapability>('unsupported');
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [promptPending, setPromptPending] = useState(false);
  const [promptVisible, setPromptVisible] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const remoteClaimsRef = useRef(new Map<string, number>());

  const acknowledge = useCallback(
    (event: AttentionEvent, action: 'accepted' | 'failed' | 'opened') => {
      void fetch(`/api/sessions/${sessionId}/attention`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notificationId: event.notificationId,
          clientId,
          action,
        }),
        keepalive: true,
      }).catch(() => undefined);
    },
    [clientId, sessionId],
  );

  useEffect(() => {
    setCapability(getBrowserNotificationCapability());
    setCapabilityReady(true);
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('roomote-browser-notifications');
    channel.onmessage = (message: MessageEvent<{ eventKey?: unknown }>) => {
      if (typeof message.data?.eventKey === 'string') {
        remoteClaimsRef.current.set(message.data.eventKey, Date.now());
      }
    };
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !capabilityReady) return;
    const source = new EventSource(
      `/api/sessions/${sessionId}/attention/stream?clientId=${encodeURIComponent(clientId)}&permission=${encodeURIComponent(capability)}`,
    );
    const onAttention = (message: MessageEvent) => {
      const event = JSON.parse(message.data) as AttentionEvent;
      if (event.mode === 'prompt') {
        if (
          capability === 'default' &&
          getBrowserNotificationPromptState() === null
        ) {
          setPromptPending(true);
        }
        return;
      }
      if (
        capability !== 'granted' ||
        !event.offerExpiresAt ||
        Date.parse(event.offerExpiresAt) <= Date.now() ||
        (document.visibilityState === 'visible' && document.hasFocus()) ||
        Date.now() - (remoteClaimsRef.current.get(event.eventKey) ?? 0) <
          15_000 ||
        !claimBrowserNotification(event.eventKey)
      ) {
        return;
      }
      channelRef.current?.postMessage({ eventKey: event.eventKey });
      try {
        const notification = new Notification(event.title, {
          body: event.body,
          tag: event.eventKey,
        });
        acknowledge(event, 'accepted');
        notification.onclick = () => {
          acknowledge(event, 'opened');
          notification.close();
          window.focus();
          if (
            `${window.location.pathname}${window.location.search}` !==
            event.href
          ) {
            window.location.assign(event.href);
          }
        };
      } catch {
        acknowledge(event, 'failed');
      }
    };
    source.addEventListener('attention', onAttention);
    return () => {
      source.removeEventListener('attention', onAttention);
      source.close();
    };
  }, [acknowledge, capability, capabilityReady, clientId, enabled, sessionId]);

  useEffect(() => {
    if (!promptPending) return;
    const showWhenFocused = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus())
        return;
      if (getBrowserNotificationPromptState() !== null) return;
      setBrowserNotificationPromptState('shown');
      setPromptVisible(true);
    };
    showWhenFocused();
    window.addEventListener('focus', showWhenFocused);
    document.addEventListener('visibilitychange', showWhenFocused);
    return () => {
      window.removeEventListener('focus', showWhenFocused);
      document.removeEventListener('visibilitychange', showWhenFocused);
    };
  }, [promptPending]);

  const prompt = promptVisible ? (
    <BrowserNotificationPermissionPrompt
      onEnable={() => {
        void Notification.requestPermission().then((permission) => {
          setCapability(permission);
          setPromptVisible(false);
          setPromptPending(false);
        });
      }}
      onDismiss={() => {
        setBrowserNotificationPromptState('dismissed');
        setPromptVisible(false);
        setPromptPending(false);
      }}
    />
  ) : null;

  return { prompt };
}
