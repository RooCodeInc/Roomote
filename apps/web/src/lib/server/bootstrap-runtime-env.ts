import { configureAuthClientEnv } from '@roomote/auth/client';

import {
  assertSecureWebBoot,
  initializeWebRuntimeEnv,
  installWebSecretProvider,
  rehydrateWebEnv,
} from './env';

type WebRuntimeEnv = ReturnType<typeof initializeWebRuntimeEnv>;

let bootstrapWebRuntimeEnvPromise: Promise<WebRuntimeEnv> | null = null;

async function runBootstrapWebRuntimeEnv(): Promise<WebRuntimeEnv> {
  let webEnv = initializeWebRuntimeEnv();

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Route the shared secret accessors through the web-owned dotenvx resolver
    // for the lifetime of this process.
    installWebSecretProvider();

    const { initializeDb, bootstrapGeneratedAuthKeypairs } =
      await import('@roomote/db/server');
    await initializeDb(webEnv.DATABASE_URL);

    // When R_AUTO_GENERATE_KEYS is enabled, resolve auto-generated
    // auth keypairs from the database (generating them at first boot) and
    // rebuild the web env so token signing observes the resolved keys.
    if (await bootstrapGeneratedAuthKeypairs()) {
      webEnv = rehydrateWebEnv();
    }

    assertSecureWebBoot();
  }

  configureAuthClientEnv({
    nodeEnv: webEnv.NODE_ENV,
    jobAuthPrivateKey:
      webEnv.JOB_AUTH_PRIVATE_KEY || process.env.JOB_AUTH_PRIVATE_KEY,
    jobAuthPublicKey:
      webEnv.JOB_AUTH_PUBLIC_KEY || process.env.JOB_AUTH_PUBLIC_KEY,
    previewAuthPrivateKey:
      webEnv.PREVIEW_AUTH_PRIVATE_KEY || process.env.PREVIEW_AUTH_PRIVATE_KEY,
    previewAuthPublicKey:
      webEnv.PREVIEW_AUTH_PUBLIC_KEY || process.env.PREVIEW_AUTH_PUBLIC_KEY,
  });

  return webEnv;
}

export async function bootstrapWebRuntimeEnv(): Promise<WebRuntimeEnv> {
  // Keep the successful bootstrap memoized so repeated callers (for example
  // per-request auth checks) do not re-run env file loading and DB
  // initialization. Only clear the promise on failure so callers can retry.
  bootstrapWebRuntimeEnvPromise ??= runBootstrapWebRuntimeEnv().catch(
    (error) => {
      bootstrapWebRuntimeEnvPromise = null;
      throw error;
    },
  );

  return bootstrapWebRuntimeEnvPromise;
}
