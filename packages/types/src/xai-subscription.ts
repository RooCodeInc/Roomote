/**
 * xAI Grok subscription OAuth constants.
 *
 * These reuse the public Grok CLI OAuth client identity and device-code
 * endpoints used by peer agents (Hermes, OpenClaw, CC Switch). Roomote does
 * not register its own xAI OAuth app; tokens authenticate chat/coding
 * inference against `https://api.x.ai` under the existing `xai/` model-id
 * prefix.
 */

/** Public Grok CLI client id shared by ecosystem tools. */
export const DEFAULT_XAI_OAUTH_CLIENT_ID =
  'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_CLIENT_ID_ENV_VAR_NAME = 'XAI_OAUTH_CLIENT_ID';

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DEVICE_CODE_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_OAUTH_TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth2/token`;
/** Fallback verification URL when the device-code response omits one. */
export const XAI_OAUTH_DEVICE_VERIFICATION_URL = 'https://accounts.x.ai';

/**
 * Scopes requested by the official Grok CLI for SuperGrok / eligible Premium+
 * API access, including offline_access so Roomote can refresh server-side.
 */
export const XAI_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

/** opencode / models.dev provider id for Grok models (`xai/<model>`). */
export const XAI_OPENCODE_PROVIDER_ID = 'xai';

/**
 * Refresh an access token this many milliseconds before its stated expiry.
 * xAI access tokens are short-lived (~6h); one hour of margin keeps long
 * gateway/cron workloads from hitting brief credential-expiry gaps.
 */
export const XAI_REFRESH_SAFETY_MARGIN_MS = 60 * 60 * 1000;

/**
 * Default access-token lifetime when the token endpoint omits `expires_in`.
 * Matches observed SuperGrok device-code grants (~6 hours).
 */
export const XAI_DEFAULT_ACCESS_TOKEN_TTL_MS = 6 * 3600 * 1000;

/** GitHub-style slow_down bump when the token endpoint asks for it. */
export const XAI_POLL_SLOW_DOWN_MS = 5_000;
