// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// Note: User context is set via UserAnalyticsContext component.

import * as Sentry from '@sentry/nextjs';

import {
  isWebSentryEnabled,
  resolveWebSentryEnvironment,
  resolveWebSentryRelease,
} from '@/lib/sentry-config';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: isWebSentryEnabled(),
  environment: resolveWebSentryEnvironment(),
  release: resolveWebSentryRelease(),
  tracesSampleRate: 1,
  debug: false,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Increase max length for messages to prevent truncation (default is 250).
  maxValueLength: 8192,

  integrations: [
    Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
  ],
});

// This export will instrument router navigations, and is only relevant if you
// enable tracing.
// `captureRouterTransitionStart` is available from SDK version 9.12.0 onwards.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
