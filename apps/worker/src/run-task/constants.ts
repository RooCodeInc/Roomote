export {
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_DEV_MS,
} from '@roomote/types';

/** Environment variables allowed to pass through to the child subprocess. */
export const ALLOWED_ENV_VARS = [
  'HOME',
  'PNPM_HOME',
  'PATH',
  'NODE_ENV',
  'GH_TOKEN',
  'LC_ALL',
  'DISPLAY',
];

/** Grace period (ms) to wait for the subprocess to exit after sending close/abort signals. */
export const SUBPROCESS_TIMEOUT_MS = 10_000;
