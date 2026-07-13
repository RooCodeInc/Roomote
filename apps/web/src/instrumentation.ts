import * as Sentry from '@sentry/nextjs';

import {
  isWebSentryEnabled,
  resolveWebSentryEnvironment,
  resolveWebSentryRelease,
} from '@/lib/sentry-config';

export const onRequestError = Sentry.captureRequestError;

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Keep this Node-only bootstrap out of the Edge bundle.
    const { bootstrapWebRuntimeEnv } =
      await import('@/lib/server/bootstrap-runtime-env');

    await bootstrapWebRuntimeEnv();

    // Non-fatal, detached reconciliation of E2B/Daytona/Blaxel artifacts.
    // A release image or worker-runtime schema change creates a replacement
    // artifact and atomically activates it only after the build succeeds.
    void import('@/trpc/commands/compute/compute-provisioning')
      .then(({ reconcileComputeProvisioningOnStartup }) =>
        reconcileComputeProvisioningOnStartup(),
      )
      .catch((error) => {
        console.error(
          `[instrumentation] Hosted worker artifact reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  const environment = resolveWebSentryEnvironment();
  const release = resolveWebSentryRelease();

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Node.js Sentry configuration.
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: isWebSentryEnabled(),
      environment,
      release,

      // Adjust this value in production, or use tracesSampler for greater control.
      tracesSampleRate: 1,

      // Setting this option to true will print useful information to the
      // console while you're setting up Sentry.
      debug: false,

      // Increase max length for messages to prevent truncation (default is 250).
      maxValueLength: 8192,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    // Edge Sentry configuration.
    // Note: User context is set in layouts via setSentryUserContext().
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: isWebSentryEnabled(),
      environment,
      release,
      tracesSampleRate: 1,
      debug: false,
      maxValueLength: 8192,
    });
  }
}
