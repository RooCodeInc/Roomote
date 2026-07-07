import * as Sentry from '@sentry/nextjs';

interface SentryUserContext {
  id: string;
}

/**
 * Sets the Sentry user context for server-side error tracking.
 */
export function setSentryUserContext(context: SentryUserContext) {
  Sentry.setUser({
    id: context.id,
  });
}
