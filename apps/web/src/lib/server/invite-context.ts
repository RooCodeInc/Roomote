import { AsyncLocalStorage } from 'node:async_hooks';

import { INVITE_COOKIE_NAME } from '../invite-cookie';

/**
 * Carries the visitor's invite token (from the invite cookie) into Better
 * Auth database hooks, which run inside `handleAuthRequest` and have no
 * other access to the request. Outside that scope, callers fall back to
 * reading the cookie via next/headers.
 */

export { INVITE_COOKIE_NAME };

type InviteRequestContext = {
  inviteToken: string | null;
};

const inviteContextStorage = new AsyncLocalStorage<InviteRequestContext>();

export function extractInviteTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');

  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');

    if (name === INVITE_COOKIE_NAME) {
      const value = valueParts.join('=').trim();

      return value ? decodeURIComponent(value) : null;
    }
  }

  return null;
}

export function runWithInviteContext<T>(
  inviteToken: string | null,
  callback: () => T,
): T {
  return inviteContextStorage.run({ inviteToken }, callback);
}

async function getInviteTokenFromCookies(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const value = cookieStore.get(INVITE_COOKIE_NAME)?.value;

    return value ? decodeURIComponent(value) : null;
  } catch {
    // Not inside a Next.js request scope.
    return null;
  }
}

/**
 * The visitor's invite token, from the Better Auth request context when
 * running inside `handleAuthRequest`, otherwise from the request cookies.
 */
export async function getRequestInviteToken(): Promise<string | null> {
  const store = inviteContextStorage.getStore();

  if (store) {
    return store.inviteToken;
  }

  return getInviteTokenFromCookies();
}
