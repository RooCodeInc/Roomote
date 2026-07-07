/**
 * OpenRouter PKCE OAuth helpers.
 *
 * OpenRouter supports connecting users via PKCE (https://openrouter.ai/docs/guides/overview/auth/oauth):
 * 1. Send the user to `https://openrouter.ai/auth` with a `callback_url` and an
 *    S256 `code_challenge` derived from a locally stored `code_verifier`.
 * 2. OpenRouter redirects back to the callback with a one-time `code`.
 * 3. Exchange the code (plus the original `code_verifier`) at
 *    `https://openrouter.ai/api/v1/auth/keys` for a user-controlled API key.
 *
 * The verifier is kept in a short-lived HTTP-only cookie between the two
 * redirects; PKCE itself guarantees a foreign authorization code cannot be
 * exchanged without the verifier stored in the operator's browser.
 */

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

export const OPENROUTER_OAUTH_VERIFIER_COOKIE = 'openrouter-oauth-verifier';
export const OPENROUTER_OAUTH_COOKIE_PATH = '/api/openrouter-oauth';
export const OPENROUTER_OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export function buildOpenRouterAuthorizationUrl({
  callbackUrl,
  codeChallenge,
}: {
  callbackUrl: string;
  codeChallenge: string;
}): string {
  const authUrl = new URL(OPENROUTER_AUTH_URL);
  authUrl.searchParams.set('callback_url', callbackUrl);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return authUrl.toString();
}

export async function exchangeOpenRouterCodeForApiKey({
  code,
  codeVerifier,
}: {
  code: string;
  codeVerifier: string;
}): Promise<string> {
  const response = await fetch(OPENROUTER_KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter key exchange failed with status ${response.status}`,
    );
  }

  const payload: unknown = await response.json();
  const key =
    payload && typeof payload === 'object' && 'key' in payload
      ? (payload as { key: unknown }).key
      : undefined;

  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('OpenRouter key exchange returned no API key');
  }

  return key.trim();
}
