import { timingSafeEqual } from 'node:crypto';

import { Env } from './env';
import { resolveAppEnv } from '../app-env';

function safeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

/**
 * Whether an empty deployment may bootstrap its first admin WITHOUT a
 * SETUP_TOKEN. Only local development is allowed to; every other environment
 * must configure SETUP_TOKEN so an attacker who reaches an exposed deployment
 * before the operator cannot claim the first-admin slot.
 *
 * This fails closed: a production Node runtime is never treated as local. That
 * guard matters because `APP_ENV` is optional and `resolveAppEnv()` falls back
 * to `'development'` when it and the Vercel signals are all unset, so a
 * deployment that only set `NODE_ENV=production` would otherwise re-open
 * tokenless bootstrap. Mirrors the app-env portion of the dev-login gate
 * (`NODE_ENV !== 'production'` plus an explicit development app env); dev
 * login additionally requires its own WEB_DEV_LOGIN_ENABLED opt-in.
 */
function isTokenlessBootstrapAllowed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    resolveAppEnv(process.env) === 'development'
  );
}

export function isSetupTokenRequired(): boolean {
  // A setup token gates first-admin bootstrap everywhere except local
  // development, where tokenless bootstrap stays a convenience.
  return Boolean(Env.SETUP_TOKEN) || !isTokenlessBootstrapAllowed();
}

export function isSetupTokenValid(setupToken: string | undefined): boolean {
  const requiredToken = Env.SETUP_TOKEN;

  if (!requiredToken) {
    // With no token configured, only local development may bootstrap; a
    // non-local deployment cannot be satisfied until SETUP_TOKEN is set.
    return isTokenlessBootstrapAllowed();
  }

  return setupToken != null && safeEquals(setupToken, requiredToken);
}

export function assertSetupTokenValid(setupToken: string | undefined): void {
  if (!isSetupTokenValid(setupToken)) {
    throw new Error(
      'A valid setup token is required. Use the setup link printed by the installer, or read SETUP_TOKEN from the deployment env file.',
    );
  }
}
