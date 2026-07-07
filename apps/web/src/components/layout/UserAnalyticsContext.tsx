'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

import { useUser } from '@/hooks/useUser';

/**
 * Client-side component that syncs Sentry user context with application
 * authentication state.
 */
export function UserAnalyticsContext() {
  const { user } = useUser();

  useEffect(() => {
    if (user) {
      Sentry.setUser({
        id: user.userId,
      });
    } else {
      // Clear user context when not authenticated.
      Sentry.setUser(null);
    }
  }, [user]);

  // This component doesn't render anything.
  return null;
}
