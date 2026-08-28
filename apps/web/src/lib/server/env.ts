import { existsSync } from 'node:fs';
import path from 'node:path';

import * as dotenvx from '@dotenvx/dotenvx';
import {
  areCuratedIntegrationsDisabled,
  isCustomMcpDisabled,
  createRoomoteEnv,
  getAllowedDevOrigins as getSharedAllowedDevOrigins,
  getArtifactSigningKey,
  getArtifactSigningKeyPrevious,
  getBetterAuthSecret,
  getRuntimeBootstrapState,
  assertSecureBootBinding as sharedAssertSecureBootBinding,
  getWebBundledEnvFilePaths as getSharedWebBundledEnvFilePaths,
  getWebEnvFilePaths as getSharedWebEnvFilePaths,
  isBrainConfigured,
  isEnvFlagEnabled,
  isExposedBindHost,
  isRoomoteCloudEnabled,
  rehydrateEnv as rehydrateSharedEnv,
  setSecretProvider,
  type SecretName,
  type SecretProvider,
} from '@roomote/env';

import {
  getStaticOauthEnvPartnerKey,
  resolveStaticOauthEnvValue,
} from './mcp-static-oauth';

import { type AppEnv, resolveAppEnv } from '../app-env';

/**
 * Runtime environment accessor backed by dotenvx.
 *
 * Uses the shared @roomote/env schema, but resolves raw values through
 * dotenvx first so preview deploys can decrypt runtime env files on Vercel
 * without relying on process.env already being populated.
 *
 * The web runtime bootstrap loads dotenvx-backed files during startup, and the
 * web-owned Env proxy only falls back to first-access initialization outside
 * the real Next.js runtime lifecycle (for example in tests and tooling).
 */

type RoomoteEnv = ReturnType<typeof createRoomoteEnv>;
type WebRuntimeEnvInitReason = 'explicit-bootstrap' | 'lazy';
type WebRuntimeEnvDiagnostics = {
  nextRuntime: 'nodejs' | 'edge' | 'unknown';
  appEnv: AppEnv;
  bootstrapCompleted: boolean;
  isBuildPhase: boolean;
  nextPhase: string | null;
};

let webRuntimeEnvFilesUnavailable = false;

function getNextRuntime(
  env: NodeJS.ProcessEnv = process.env,
): 'nodejs' | 'edge' | undefined {
  return env.NEXT_RUNTIME === 'nodejs' || env.NEXT_RUNTIME === 'edge'
    ? env.NEXT_RUNTIME
    : undefined;
}

export function getWebRuntimeEnvDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
): WebRuntimeEnvDiagnostics {
  const nextRuntime = getNextRuntime(env);

  return {
    nextRuntime: nextRuntime ?? 'unknown',
    appEnv: resolveAppEnv(env),
    bootstrapCompleted: getRuntimeBootstrapState().hasExplicitBootstrap,
    isBuildPhase: isNextBuildPhase(env),
    nextPhase: env.NEXT_PHASE ?? null,
  };
}

function isNextBuildPhase(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_PHASE === 'phase-production-build';
}

function assertSupportedWebRuntime(nextRuntime = getNextRuntime()): void {
  if (nextRuntime === 'edge') {
    throw new Error(
      'apps/web does not support the Next.js Edge runtime. Use the Node.js runtime for server routes because dotenvx runtime env loading depends on Node.js APIs.',
    );
  }
}

function loadWebRuntimeEnvFiles(): void {
  const nextRuntime = getNextRuntime();
  assertSupportedWebRuntime(nextRuntime);
  const appEnv = resolveAppEnv(process.env);

  const envFilePaths = [...getSharedWebEnvFilePaths(appEnv)].filter(
    (envFilePath) => existsSync(path.resolve(process.cwd(), envFilePath)),
  );

  // Skip dotenvx entirely when no env files exist (for example hosted deploys
  // configured purely through process.env). dotenvx logs MISSING_ENV_FILE to
  // stderr even with `quiet`, which floods logs on every bootstrap otherwise.
  if (envFilePaths.length === 0) {
    webRuntimeEnvFilesUnavailable = true;
    return;
  }

  const result = dotenvx.config({
    path: envFilePaths,
    quiet: true,
    strict: false,
  });

  webRuntimeEnvFilesUnavailable = !!result.error;
}

function getDotenvxString(key: string): string | undefined {
  if (webRuntimeEnvFilesUnavailable) {
    const processValue = process.env[key];
    return typeof processValue === 'string' && processValue.trim()
      ? processValue
      : undefined;
  }

  const value = dotenvx.get(key, {
    ignore: ['MISSING_ENV_FILE', 'MISSING_KEY'],
  });

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveDotenvxValue(key: string): string | undefined {
  const partnerKey = getStaticOauthEnvPartnerKey(key);
  if (!partnerKey) {
    return getDotenvxString(key);
  }

  const value = getDotenvxString(key);
  const partnerValue = getDotenvxString(partnerKey);

  return resolveStaticOauthEnvValue(
    {
      ...process.env,
      ...(value ? { [key]: value } : {}),
      ...(partnerValue ? { [partnerKey]: partnerValue } : {}),
    },
    key,
  );
}

function createEnvProxy(getCurrentEnv: () => RoomoteEnv): RoomoteEnv {
  return new Proxy({} as RoomoteEnv, {
    get(_target, prop, receiver) {
      return Reflect.get(getCurrentEnv(), prop, receiver);
    },
    has(_target, prop) {
      return Reflect.has(getCurrentEnv(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getCurrentEnv());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        getCurrentEnv(),
        prop,
      );

      if (!descriptor) {
        return descriptor;
      }

      return { ...descriptor, configurable: true };
    },
  });
}

let webRuntimeEnv: RoomoteEnv | null = null;

function getWebRuntimeEnv(): RoomoteEnv {
  if (webRuntimeEnv) {
    return webRuntimeEnv;
  }

  const nextRuntime = getNextRuntime();

  if (
    nextRuntime === 'nodejs' &&
    !getRuntimeBootstrapState().hasExplicitBootstrap &&
    !isNextBuildPhase()
  ) {
    throw new Error(
      'apps/web runtime env was accessed before instrumentation register() completed. Bootstrap the Next.js Node.js runtime from instrumentation.ts before reading Env.',
    );
  }

  return initializeWebRuntimeEnv({ reason: 'lazy' });
}

export {
  areCuratedIntegrationsDisabled,
  isCustomMcpDisabled,
  getArtifactSigningKey,
  getArtifactSigningKeyPrevious,
  getBetterAuthSecret,
  isBrainConfigured,
  isEnvFlagEnabled,
  isRoomoteCloudEnabled,
  resolveAppEnv,
};

/** Whether the web server binds a non-loopback interface. */
export function isWebServerBindExposed(): boolean {
  return isExposedBindHost(process.env.HOST);
}

/** Web-env binding of {@link sharedAssertSecureBootBinding}. */
export function assertSecureWebBoot(): void {
  sharedAssertSecureBootBinding({ env: Env });
}

/**
 * Secret provider backed by the web-owned dotenvx resolver rather than the
 * shared `@roomote/env` singleton. This keeps request-time secret reads
 * (`getEncryptionKey()` etc.) resolving through `resolveDotenvxValue` at read
 * time, so a value that lands in `process.env` in an encrypted/stale form on a
 * preview deploy does not diverge from the freshly-decrypted dotenvx value.
 */
const webSecretProvider: SecretProvider = {
  getSecret(name: SecretName): string | undefined {
    return Env[name] || undefined;
  },
};

/**
 * Install the web-owned secret provider. Call during web runtime bootstrap so
 * the shared secret accessors resolve through the web resolver in this process.
 */
export function installWebSecretProvider(): void {
  setSecretProvider(webSecretProvider);
}

export function getWebBundledEnvFilePaths(appEnv: AppEnv): readonly string[] {
  return getSharedWebBundledEnvFilePaths(appEnv);
}

export function getAllowedDevOrigins(
  previewDomainsRaw: string | undefined,
): readonly string[] {
  return getSharedAllowedDevOrigins(previewDomainsRaw);
}

export function initializeWebRuntimeEnv({
  reason = 'explicit-bootstrap',
}: {
  reason?: WebRuntimeEnvInitReason;
} = {}): RoomoteEnv {
  loadWebRuntimeEnvFiles();
  rehydrateSharedEnv(process.env);
  webRuntimeEnv = rehydrateWebEnv();

  if (reason === 'explicit-bootstrap') {
    getRuntimeBootstrapState().hasExplicitBootstrap = true;
  }

  return webRuntimeEnv;
}

export function rehydrateWebEnv(): RoomoteEnv {
  webRuntimeEnv = createRoomoteEnv(process.env, resolveDotenvxValue);
  return webRuntimeEnv;
}

export const Env = createEnvProxy(getWebRuntimeEnv);
