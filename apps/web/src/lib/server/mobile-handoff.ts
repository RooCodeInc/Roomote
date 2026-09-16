import { randomBytes } from 'node:crypto';

import { getRedis } from '@roomote/redis';

/**
 * One-time codes that hand a browser sign-in over to a native client.
 *
 * The iOS app opens `/api/auth/mobile-handoff` in an authentication web
 * session. Once the browser is signed in (by any provider the deployment
 * offers), the route stores the browser's signed session token under a
 * short-lived code and redirects to the app's custom scheme. The app trades
 * the code for the token over HTTPS and uses it as a bearer token from then
 * on. The code is single-use and never appears in a page the app renders.
 */

const CODE_TTL_SECONDS = 60;
const KEY_PREFIX = 'mobile-handoff:';

const MOBILE_HANDOFF_REDIRECT_SCHEME = 'roomote';

export function isAllowedHandoffRedirect(redirect: string): boolean {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return false;
  }
  return (
    url.protocol === `${MOBILE_HANDOFF_REDIRECT_SCHEME}:` &&
    url.username === '' &&
    url.password === ''
  );
}

export async function storeMobileHandoffToken(
  sessionToken: string,
): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await getRedis().set(
    `${KEY_PREFIX}${code}`,
    sessionToken,
    'EX',
    CODE_TTL_SECONDS,
  );
  return code;
}

export async function consumeMobileHandoffToken(
  code: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null;
  const key = `${KEY_PREFIX}${code}`;
  const redis = getRedis();
  const results = await redis.multi().get(key).del(key).exec();
  const token = results?.[0]?.[1];
  return typeof token === 'string' && token.length > 0 ? token : null;
}
