import { Env } from '@roomote/env';
import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES,
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
  isTaskModelIdDisabled,
  parseModelProviderEnvKeys,
} from '@roomote/types';

import type { BuildWorkerEnvOptions } from './types';

const BLOCKED_WORKER_ENV_KEYS = new Set([
  'JOB_AUTH_PRIVATE_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'BETTER_AUTH_SECRET',
  'DASHBOARD_PASSWORD',
  'SETUP_TOKEN',
  'MODAL_TOKEN_SECRET',
  // The hosting-managed Roomote inference key is gateway-served. Block it so
  // no env passthrough can ever ship it into a sandbox.
  'R_TRIAL_OPENROUTER_API_KEY',
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
  ...DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
]);

function isBlockedWorkerEnvKey(key: string): boolean {
  if (BLOCKED_WORKER_ENV_KEYS.has(key)) {
    return true;
  }

  // Denylist sensitive suffixes so a typo in R_MODEL_ENV_KEYS cannot ship
  // deployment credentials into untrusted sandboxes.
  return (
    /_SECRET$/i.test(key) ||
    /_PRIVATE_KEY$/i.test(key) ||
    /PASSWORD$/i.test(key)
  );
}
const MODEL_ROLE_ENV_VAR_NAMES = new Set<string>([
  'R_MODEL',
  'R_SMALL_MODEL',
  'R_VISION_MODEL',
  'R_CODE_REVIEW_MODEL',
  'R_EXPLORE_MODEL',
  'R_PLANNING_MODEL',
]);

function filterWorkerExtraEnv(
  extraEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!extraEnv) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(extraEnv).filter(
      ([key, value]) =>
        !isBlockedWorkerEnvKey(key) &&
        (!MODEL_ROLE_ENV_VAR_NAMES.has(key) || !isTaskModelIdDisabled(value)),
    ),
  );
}

function getOperatorModelProviderEnvKeys(): string[] {
  const configured = parseModelProviderEnvKeys(process.env.R_MODEL_ENV_KEYS);

  return [...new Set([...DEFAULT_MODEL_PROVIDER_ENV_KEYS, ...configured])];
}

function buildOperatorModelProviderEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of MODEL_ROLE_ENV_VAR_NAMES) {
    const modelId = process.env[key]?.trim();

    if (modelId && !isTaskModelIdDisabled(modelId)) {
      env[key] = modelId;
    }
  }

  for (const key of [
    'R_MODEL_REASONING_EFFORT',
    'R_SMALL_MODEL_REASONING_EFFORT',
    'R_VISION_MODEL_REASONING_EFFORT',
    'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
    'R_EXPLORE_MODEL_REASONING_EFFORT',
    'R_PLANNING_MODEL_REASONING_EFFORT',
  ] as const) {
    const value = process.env[key]?.trim();

    if (value) {
      env[key] = value;
    }
  }

  if (process.env.R_MODEL_ENV_KEYS?.trim()) {
    env.R_MODEL_ENV_KEYS = process.env.R_MODEL_ENV_KEYS;
  }

  // Gateway-covered provider keys (OpenRouter, Anthropic, OpenAI, Gemini,
  // the aggregators, Bedrock) stay off the worker daemon process env so they
  // never appear in the sandbox's /proc; the per-task dequeue env routes the
  // harness through the inference gateway instead. ChatGPT subscriptions use
  // their dedicated run-token gateway route, while disabled-provider
  // credentials such as Vertex are blocked from the worker env entirely.
  const gatewayCoveredKeys = new Set(INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES);

  for (const key of getOperatorModelProviderEnvKeys()) {
    if (isBlockedWorkerEnvKey(key)) {
      continue;
    }

    if (gatewayCoveredKeys.has(key)) {
      continue;
    }

    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

export function buildBaseWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  environmentId,
}: BuildWorkerEnvOptions): Record<string, string> {
  const previewProxyBaseUrl = process.env.PREVIEW_PROXY_BASE_URL;

  return {
    AUTH_TOKEN: authToken,
    // Intentionally reads process.env.APP_ENV (not the resolved `appEnv`)
    // so we only forward an explicit APP_ENV setting. resolveAppEnv() may
    // derive a value from other env vars that reflect the *controller's*
    // deploy context, not necessarily the environment the worker should
    // operate in.
    ...(process.env.APP_ENV && {
      R_APP_ENV: process.env.APP_ENV,
      // Legacy alias: pre-rename snapshot workers read ROOMOTE_APP_ENV and
      // would otherwise fall back to development behavior. Remove with the
      // ROOMOTE_APP_URL alias below once pre-rename snapshots have aged out.
      ROOMOTE_APP_ENV: process.env.APP_ENV,
    }),
    ...(sandboxExpiresAtMs !== undefined && {
      SANDBOX_EXPIRES_AT_MS: String(sandboxExpiresAtMs),
    }),
    R_APP_URL: Env.R_APP_URL,
    // Legacy alias: sandboxes resumed from snapshots created before the R_*
    // rename run a worker build that requires ROOMOTE_APP_URL at startup.
    // Remove once pre-rename snapshots have aged out.
    ROOMOTE_APP_URL: Env.R_APP_URL,
    TRPC_URL: Env.TRPC_URL,
    SKIP_ENV_VALIDATION: '1',
    // These are launcher-to-worker transport values. Keep them tied to the
    // current process env instead of the shared Env snapshot because the worker
    // bootstrap captures and scrubs them very early for nested-sandbox safety.
    // Only the public key is needed in worker sandboxes for token validation;
    // token-signing private keys must remain in server/controller runtimes.
    ...(process.env.JOB_AUTH_PUBLIC_KEY && {
      JOB_AUTH_PUBLIC_KEY: process.env.JOB_AUTH_PUBLIC_KEY,
    }),
    ...(process.env.PREVIEW_AUTH_PUBLIC_KEY && {
      PREVIEW_AUTH_PUBLIC_KEY: process.env.PREVIEW_AUTH_PUBLIC_KEY,
    }),
    ...(previewProxyBaseUrl && {
      PREVIEW_PROXY_BASE_URL: previewProxyBaseUrl,
    }),
    ...(process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX && {
      PREVIEW_PROXY_SUBDOMAIN_SUFFIX:
        process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX,
    }),
    ...(process.env.PREVIEW_AUTH_COOKIE_NAME && {
      PREVIEW_AUTH_COOKIE_NAME: process.env.PREVIEW_AUTH_COOKIE_NAME,
    }),
    ...buildOperatorModelProviderEnv(),
    ...filterWorkerExtraEnv(extraEnv),
    ...(environmentId &&
      process.env[SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME] && {
        [SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME]:
          process.env[SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME],
      }),
  };
}
