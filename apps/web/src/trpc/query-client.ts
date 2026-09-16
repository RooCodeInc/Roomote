import {
  MutationCache,
  QueryClient,
  QueryCache,
  defaultShouldDehydrateQuery,
} from '@tanstack/react-query';
import superjson from 'superjson';

import { buildSignInRedirectUrl } from '@/lib/sign-in-redirect';

type BrowserLocation = Pick<Location, 'assign' | 'pathname' | 'search'>;

export function redirectUnauthorizedError(
  error: unknown,
  location: BrowserLocation,
): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('data' in error) ||
    typeof error.data !== 'object' ||
    error.data === null ||
    !('code' in error.data) ||
    error.data.code !== 'UNAUTHORIZED'
  ) {
    return false;
  }

  location.assign(
    buildSignInRedirectUrl(`${location.pathname}${location.search}`),
  );
  return true;
}

export function createQueryClient() {
  let redirectingToSignIn = false;
  const handleError = (error: unknown) => {
    if (
      redirectingToSignIn ||
      typeof window === 'undefined' ||
      !redirectUnauthorizedError(error, window.location)
    ) {
      return;
    }

    redirectingToSignIn = true;
  };

  return new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: { staleTime: 30 * 1000 },
      dehydrate: {
        serializeData: superjson.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === 'pending',
      },
      hydrate: { deserializeData: superjson.deserialize },
    },
  });
}
