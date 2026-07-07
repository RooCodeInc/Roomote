/**
 * Cookie carrying the visitor's invite token (or the deployment setup token
 * acting as the system invite) through sign-up, including OAuth redirects.
 * Client-safe; the server-side plumbing lives in lib/server/invite-context.
 */
export const INVITE_COOKIE_NAME = 'roomote-invite';

/**
 * Reads the invite cookie from `document.cookie`. OAuth round-trips drop any
 * `?token=` query param, so the cookie is the only place the setup token
 * survives a redirect back into the app.
 */
export function readInviteTokenFromDocumentCookie(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  for (const part of document.cookie.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');

    if (name === INVITE_COOKIE_NAME) {
      const value = valueParts.join('=').trim();

      return value ? decodeURIComponent(value) : null;
    }
  }

  return null;
}
