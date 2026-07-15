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
};

declare global {
  interface Window {
    posthog?: PostHog;
    Intercom?: (command: 'boot', settings: { app_id: string }) => void;
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
  const intercomBooted = useRef(false);
  const resolvedPosthogHost = posthogHost ?? DEFAULT_POSTHOG_HOST;

  const bootIntercom = () => {
    if (intercomBooted.current || !window.Intercom || !intercomAppId) {
      return;
    }
    intercomBooted.current = true;
    window.Intercom('boot', { app_id: intercomAppId });
  };

  useEffect(() => {
    if (userId && window.posthog) {
      if (window.posthog.identify) {
        window.posthog.identify(userId);
      } else {
        window.posthog.push(['identify', userId]);
      }
    }
  }, [userId]);

  if (!cloudEnabled) {
    return null;
  }

  return (
    <>
      {posthogProjectKey && (
        <>
          <script
            dangerouslySetInnerHTML={{
              __html: `window.posthog=window.posthog||[];window.posthog._i=window.posthog._i||[];window.posthog.init=window.posthog.init||function(k,o){window.posthog._i.push([k,o])};window.posthog.identify=window.posthog.identify||function(id){window.posthog.push(['identify',id])};window.posthog.init(${JSON.stringify(posthogProjectKey)},${JSON.stringify({ api_host: resolvedPosthogHost, disable_session_recording: false })});${userId ? `window.posthog.identify(${JSON.stringify(userId)});` : ''}`,
            }}
          />
          <script
            async
            data-testid="posthog-script"
            src={`${resolvedPosthogHost.replace(/\/$/, '')}/static/array.js`}
          />
        </>
      )}
      {intercomAppId && (
        <script
          async
          data-testid="intercom-script"
          onLoad={bootIntercom}
          ref={(element) => element?.addEventListener('load', bootIntercom)}
          src={`https://widget.intercom.io/widget/${intercomAppId}`}
        />
      )}
    </>
  );
}
