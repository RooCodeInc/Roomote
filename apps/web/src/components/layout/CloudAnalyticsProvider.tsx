'use client';

import { useEffect, useRef } from 'react';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogOptions = {
  api_host: string;
  disable_session_recording: boolean;
};

type PostHog = Array<[string, ...unknown[]]> & {
  _i?: Array<[string, PostHogOptions]>;
  init?: (projectKey: string, options: PostHogOptions) => void;
  identify?: (userId: string) => void;
  reset?: () => void;
};

declare global {
  interface Window {
    posthog?: PostHog;
    Intercom?: (
      command: 'boot' | 'shutdown',
      settings?: { app_id: string },
    ) => void;
  }
}

export function CloudAnalyticsProvider({
  cloudEnabled,
  intercomAppId,
  posthogProjectKey,
  posthogHost,
  userId,
}: {
  cloudEnabled: boolean;
  intercomAppId?: string;
  posthogProjectKey?: string;
  posthogHost?: string;
  userId?: string;
}) {
  const posthogLoaded = useRef(false);
  const intercomBooted = useRef(false);
  const resolvedPosthogHost = posthogHost ?? DEFAULT_POSTHOG_HOST;

  useEffect(() => {
    if (!cloudEnabled) return;
    if (posthogProjectKey) {
      const posthog = (window.posthog ??= []);
      posthog._i ??= [];
      posthog._i.push([
        posthogProjectKey,
        { api_host: resolvedPosthogHost, disable_session_recording: false },
      ]);
      posthog.identify ??= (id) => posthog.push(['identify', id]);
      posthog.reset ??= () => posthog.push(['reset']);
      const script = document.createElement('script');
      script.async = true;
      script.src = `${resolvedPosthogHost.replace(/\/$/, '')}/static/array.js`;
      script.onload = () => {
        posthogLoaded.current = true;
        if (userId) window.posthog?.identify?.(userId);
      };
      document.head.append(script);
    }
    if (intercomAppId) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://widget.intercom.io/widget/${intercomAppId}`;
      script.onload = () => {
        if (intercomBooted.current || !window.Intercom) return;
        intercomBooted.current = true;
        window.Intercom('boot', { app_id: intercomAppId });
      };
      document.head.append(script);
    }
  }, [cloudEnabled, intercomAppId, posthogProjectKey, resolvedPosthogHost]);

  useEffect(() => {
    if (!cloudEnabled || !posthogLoaded.current) return;
    if (userId) window.posthog?.identify?.(userId);
    else window.posthog?.reset?.();
  }, [cloudEnabled, userId]);

  useEffect(() => {
    if (!cloudEnabled || userId || !intercomBooted.current) return;
    window.Intercom?.('shutdown');
    intercomBooted.current = false;
  }, [cloudEnabled, userId]);

  if (!cloudEnabled) {
    return null;
  }

  return null;
}
