import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  CHATGPT_FAST_MODE_ENV_VAR_NAME,
  parseModelProviderEnvKeys,
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
} from '@roomote/types';

import { ALLOWED_ENV_VARS } from './constants';

const ALLOWED_ENV_PREFIXES = ['MISE_'];
const BLOCKED_HARNESS_ENV_KEYS = new Set([
  'AUTH_TOKEN',
  'TRPC_URL',
  'R_APP_URL',
  'JOB_AUTH_PRIVATE_KEY',
  'JOB_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_COOKIE_NAME',
  'PREVIEW_PROXY_BASE_URL',
  'PREVIEW_PROXY_SUBDOMAIN_SUFFIX',
]);
const MODEL_RUNTIME_ENV_KEYS = [
  // The gateway URL is built worker-side (run-task) from the container-
  // reachable platform URL, not delivered by dequeue. The served-keys list is
  // dequeue-delivered and read from the raw dequeue env in run-task; it is
  // allowlisted here so it survives into the harness env for config rebasing.
  'R_INFERENCE_GATEWAY_KEYS',
  'R_INFERENCE_GATEWAY_CHATGPT',
  'R_INFERENCE_GATEWAY_GITHUB_COPILOT',
  'R_INFERENCE_GATEWAY_XAI',
  CHATGPT_FAST_MODE_ENV_VAR_NAME,
  ...TASK_MODEL_ROLES.flatMap((role) => {
    const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
    return [
      descriptor.modelEnvVar,
      descriptor.reasoningEnvVar,
      descriptor.fallbackModelEnvVar,
      descriptor.fallbackReasoningEnvVar,
    ];
  }),
  'R_MODEL_ENV_KEYS',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_COMMAND',
] as const;
export function sanitizeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const allowedEnv = new Set(ALLOWED_ENV_VARS);

  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        typeof value !== 'undefined' &&
        (allowedEnv.has(key) ||
          ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
    ),
  ) as Record<string, string>;
}

export function buildOpenCodeHarnessEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const harnessEnv: Record<string, string> = {};

  for (const key of MODEL_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();

    if (value) {
      harnessEnv[key] = value;
    }
  }

  const providerKeys = new Set([
    ...DEFAULT_MODEL_PROVIDER_ENV_KEYS,
    ...parseModelProviderEnvKeys(env.R_MODEL_ENV_KEYS),
  ]);

  for (const key of providerKeys) {
    if (BLOCKED_HARNESS_ENV_KEYS.has(key)) {
      continue;
    }

    const value = env[key];

    if (value !== undefined) {
      harnessEnv[key] = value;
    }
  }

  return harnessEnv;
}
