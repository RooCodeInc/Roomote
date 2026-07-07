/**
 * OpenAI ChatGPT subscription OAuth constants.
 *
 * These mirror opencode's built-in Codex auth plugin
 * (`packages/opencode/src/plugin/openai/codex.ts`) so Roomote's device-code
 * connect flow and token refresh produce OAuth records the inner opencode
 * harness accepts under provider id `openai`. Kept in `@roomote/types` so the
 * DB refresh helper and the web tRPC connect commands share one source of
 * truth.
 */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com';
export const CHATGPT_OAUTH_DEVICE_VERIFICATION_URL = `${CHATGPT_OAUTH_ISSUER}/codex/device`;
export const CHATGPT_OAUTH_TOKEN_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
export const CHATGPT_OAUTH_DEVICE_CODE_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const CHATGPT_OAUTH_DEVICE_TOKEN_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
export const CHATGPT_OAUTH_DEVICE_CALLBACK_REDIRECT_URI = `${CHATGPT_OAUTH_ISSUER}/deviceauth/callback`;

/**
 * Env var injected into the opencode harness (worker sandbox and the API
 * routing helper) to authenticate ChatGPT subscription requests. Its value is
 * a JSON object keyed by opencode provider id (currently `openai`) matching
 * opencode's `Auth.Info` OAuth shape. The worker materializes it into the
 * sandbox `auth.json` so long-running tasks can self-refresh.
 */
export const OPENCODE_AUTH_CONTENT_ENV_VAR_NAME = 'OPENCODE_AUTH_CONTENT';

/**
 * opencode provider id under which ChatGPT subscription OAuth auth is
 * registered. opencode's Codex plugin rewrites `openai/` model requests to
 * the ChatGPT Codex backend when OAuth auth is present for this id.
 */
export const CHATGPT_OPENCODE_PROVIDER_ID = 'openai';

/**
 * Refresh an access token this many milliseconds before its stated expiry, to
 * avoid handing a token that is about to expire to a long-running task.
 */
export const CHATGPT_REFRESH_SAFETY_MARGIN_MS = 10 * 60 * 1000;

/**
 * Default access-token lifetime (1 hour) when the token endpoint omits
 * `expires_in`. Matches opencode's fallback.
 */
export const CHATGPT_DEFAULT_ACCESS_TOKEN_TTL_MS = 3600 * 1000;
