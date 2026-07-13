import { Env } from '@roomote/env';
import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  parseModelProviderEnvKeys,
} from '@roomote/types';

import type { BuildWorkerEnvOptions } from './types';

const BLOCKED_WORKER_ENV_KEYS = new Set(['JOB_AUTH_PRIVATE_KEY']);

function filterWorkerExtraEnv(
  extraEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!extraEnv) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(extraEnv).filter(
      ([key]) => !BLOCKED_WORKER_ENV_KEYS.has(key),
    ),
  );
}

function getOperatorModelProviderEnvKeys(): string[] {
  const configured = parseModelProviderEnvKeys(process.env.R_MODEL_ENV_KEYS);

  return [...new Set([...DEFAULT_MODEL_PROVIDER_ENV_KEYS, ...configured])];
}

function buildOperatorModelProviderEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const model = process.env.R_MODEL?.trim();
  const smallModel = process.env.R_SMALL_MODEL?.trim();
  const visionModel = process.env.R_VISION_MODEL?.trim();
  const codeReviewModel = process.env.R_CODE_REVIEW_MODEL?.trim();
  const exploreModel = process.env.R_EXPLORE_MODEL?.trim();
  const planningModel = process.env.R_PLANNING_MODEL?.trim();

  if (model) {
    env.R_MODEL = model;
  }

  if (smallModel) {
    env.R_SMALL_MODEL = smallModel;
  }

  if (visionModel) {
    env.R_VISION_MODEL = visionModel;
  }

  if (codeReviewModel) {
    env.R_CODE_REVIEW_MODEL = codeReviewModel;
  }

  if (exploreModel) {
    env.R_EXPLORE_MODEL = exploreModel;
  }

  if (planningModel) {
    env.R_PLANNING_MODEL = planningModel;
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

  for (const key of getOperatorModelProviderEnvKeys()) {
    if (BLOCKED_WORKER_ENV_KEYS.has(key)) {
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
}: BuildWorkerEnvOptions): Record<string, string> {
  const previewProxyBaseUrl = process.env.R_PREVIEW_PROXY_BASE_URL;

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
    R_TRPC_URL: Env.R_TRPC_URL,
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
      R_PREVIEW_PROXY_BASE_URL: previewProxyBaseUrl,
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
  };
}
