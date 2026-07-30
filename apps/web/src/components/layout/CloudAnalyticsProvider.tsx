'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogOptions = {
  api_host: string;
  disable_session_recording: boolean;
  maskInputOptions: boolean;
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
      command: 'boot' | 'shutdown' | 'show' | 'update',
      settings?: { app_id?: string; hide_default_launcher?: boolean },
    ) => void;
  }
}

function shouldShowDefaultIntercomLauncher(pathname: string | null): boolean {
  if (!pathname) return false;

  return (
    pathname.startsWith('/setup') ||
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/analytics') ||
    pathname.startsWith('/automations')
  );
}

export function CloudAnalyticsProvider({
  cloudEnabled,
  consentGranted,
  intercomAppId,
  posthogProjectKey,
  posthogHost,
  userId,
}: {
  cloudEnabled: boolean;
  consentGranted: boolean;
  intercomAppId?: string;
  posthogProjectKey?: string;
  posthogHost?: string;
  userId?: string;
}) {
  const pathname = usePathname();
  const posthogLoaded = useRef(false);
  const intercomBooted = useRef(false);
  const previousUserId = useRef(userId);
  const previousIntercomUserId = useRef(userId);
  const userIdRef = useRef(userId);
  const hideDefaultIntercomLauncherRef = useRef(false);
  const resolvedPosthogHost = posthogHost ?? DEFAULT_POSTHOG_HOST;
  const hideDefaultIntercomLauncher =
    Boolean(userId) && !shouldShowDefaultIntercomLauncher(pathname);
  userIdRef.current = userId;
  hideDefaultIntercomLauncherRef.current = hideDefaultIntercomLauncher;

  useEffect(() => {
    if (!cloudEnabled || !consentGranted) return;
    if (posthogProjectKey) {
      const posthog = (window.posthog ??= []);
      posthog._i ??= [];
      posthog._i.push([
        posthogProjectKey,
        {
          api_host: resolvedPosthogHost,
          disable_session_recording: false,
          maskInputOptions: true,
        },
      ]);
      posthog.identify ??= (id) => posthog.push(['identify', id]);
      posthog.reset ??= () => posthog.push(['reset']);
      if (!userIdRef.current) posthog.reset();
      const script = document.createElement('script');
      script.async = true;
      script.src = `${resolvedPosthogHost.replace(/\/$/, '')}/static/array.js`;
      script.onload = () => {
        posthogLoaded.current = true;
        if (userIdRef.current) window.posthog?.identify?.(userIdRef.current);
      };
      document.head.append(script);
    }
    if (intercomAppId) {
      window.Intercom?.('shutdown');
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://widget.intercom.io/widget/${intercomAppId}`;
      script.onload = () => {
        if (intercomBooted.current || !window.Intercom) return;
        intercomBooted.current = true;
        window.Intercom('boot', {
          app_id: intercomAppId,
          hide_default_launcher: hideDefaultIntercomLauncherRef.current,
        });
      };
      document.head.append(script);
    }
  }, [
    cloudEnabled,
    consentGranted,
    intercomAppId,
    posthogProjectKey,
    resolvedPosthogHost,
  ]);

  useEffect(() => {
    if (!cloudEnabled || !posthogLoaded.current) return;
    if (previousUserId.current !== userId) window.posthog?.reset?.();
    if (userId) window.posthog?.identify?.(userId);
    else window.posthog?.reset?.();
    previousUserId.current = userId;
  }, [cloudEnabled, userId]);

  useEffect(() => {
    if (!cloudEnabled || previousIntercomUserId.current === userId) return;
    window.Intercom?.('shutdown');
    intercomBooted.current = false;
    previousIntercomUserId.current = userId;
  }, [cloudEnabled, userId]);

  useEffect(() => {
    if (!cloudEnabled || !intercomBooted.current) return;
    window.Intercom?.('update', {
      hide_default_launcher: hideDefaultIntercomLauncher,
    });
  }, [cloudEnabled, hideDefaultIntercomLauncher]);

  if (!cloudEnabled) {
    return null;
  }

  return null;
}
