/** GitHub OAuth device-flow constants used by OpenCode's Copilot plugin. */
export const DEFAULT_GITHUB_COPILOT_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
export const GITHUB_COPILOT_OAUTH_CLIENT_ID_ENV_VAR_NAME =
  'GITHUB_COPILOT_OAUTH_CLIENT_ID';
export const GITHUB_COPILOT_DEVICE_CODE_ENDPOINT =
  'https://github.com/login/device/code';
export const GITHUB_COPILOT_ACCESS_TOKEN_ENDPOINT =
  'https://github.com/login/oauth/access_token';
export const GITHUB_COPILOT_DEVICE_VERIFICATION_URL =
  'https://github.com/login/device';
export const GITHUB_COPILOT_OPENCODE_PROVIDER_ID = 'github-copilot';

/** GitHub asks clients to add five seconds after a `slow_down` response. */
export const GITHUB_COPILOT_POLL_SLOW_DOWN_MS = 5_000;
