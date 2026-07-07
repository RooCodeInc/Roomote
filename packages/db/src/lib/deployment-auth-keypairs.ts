import { generateKeyPairSync } from 'node:crypto';

import {
  AUTH_KEYPAIR_ENV_KEYS,
  rehydrateEnv,
  shouldAutoGenerateAuthKeypairs,
} from '@roomote/env';
import { sql } from 'drizzle-orm';

import { db } from '../db';
import { decryptSecrets } from '../encryption';
import { deploymentSecrets } from '../schema';

/**
 * Boot-time auto-generation for the deployment auth keypairs.
 *
 * When `ROOMOTE_AUTO_GENERATE_KEYS=true` and the `JOB_AUTH_*` /
 * `PREVIEW_AUTH_*` env vars are not provided, Roomote generates the P-256
 * keypairs once, persists them encrypted in `deployment_secrets`, and loads
 * them back into the process env on every subsequent boot. Env-provided
 * values always win and are never overwritten.
 *
 * This exists for PaaS-style deployments (Railway, Render, and similar)
 * where the platform can generate random string secrets but cannot run the
 * `openssl` keypair provisioning that `deploy/install.sh` performs.
 */

interface AuthKeypairSpec {
  privateKeyName: string;
  publicKeyName: string;
  label: string;
}

const AUTH_KEYPAIRS: readonly AuthKeypairSpec[] = [
  {
    privateKeyName: 'JOB_AUTH_PRIVATE_KEY',
    publicKeyName: 'JOB_AUTH_PUBLIC_KEY',
    label: 'JOB_AUTH',
  },
  {
    privateKeyName: 'PREVIEW_AUTH_PRIVATE_KEY',
    publicKeyName: 'PREVIEW_AUTH_PUBLIC_KEY',
    label: 'PREVIEW_AUTH',
  },
];

const AUTH_KEYPAIRS_ADVISORY_LOCK_KEY = 'roomote-generated-auth-keypairs';

// Spread so services that boot in parallel with the api's db-migrate
// pre-deploy step (fresh compose or PaaS-template projects) wait out the
// pending-migration window instead of crash-looping. ~90s total.
const DEFAULT_MIGRATION_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
];

const MISSING_RELATION_PG_CODE = '42P01';

/**
 * Whether the error (or anything in its cause chain — drizzle wraps the
 * driver error in a DrizzleQueryError) is Postgres 42P01 "relation does not
 * exist", i.e. the `deployment_secrets` table has not been migrated yet.
 */
function isMissingRelationError(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 10;
    depth += 1
  ) {
    if ((current as { code?: unknown }).code === MISSING_RELATION_PG_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Generate a P-256 keypair in the env format the auth runtime expects:
 * base64-encoded PKCS#8 PEM for the private key and base64-encoded SPKI PEM
 * for the public key (the same shape `deploy/install.sh` produces with
 * openssl).
 */
function generateP256KeypairEnvValues(): {
  privateKey: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return {
    privateKey: Buffer.from(privateKey).toString('base64'),
    publicKey: Buffer.from(publicKey).toString('base64'),
  };
}

function readEnvValue(
  processEnv: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = processEnv[name]?.trim();
  return value || undefined;
}

/**
 * Resolve the auth keypairs that are missing from `processEnv` by loading
 * them from `deployment_secrets`, generating and persisting any that do not
 * exist yet. Returns the resolved env values for the missing pairs without
 * mutating `processEnv`.
 *
 * Generation is serialized with a Postgres advisory lock so concurrently
 * booting services (web, api, controller, bullmq, preview-proxy) agree on a
 * single persisted keypair.
 */
export async function ensureGeneratedAuthKeypairs(
  options: {
    processEnv?: NodeJS.ProcessEnv;
    executor?: typeof db;
  } = {},
): Promise<Record<string, string>> {
  const processEnv = options.processEnv ?? process.env;
  const executor = options.executor ?? db;

  const pendingPairs = AUTH_KEYPAIRS.filter((pair) => {
    const hasPrivateKey = Boolean(
      readEnvValue(processEnv, pair.privateKeyName),
    );
    const hasPublicKey = Boolean(readEnvValue(processEnv, pair.publicKeyName));

    if (hasPrivateKey !== hasPublicKey) {
      throw new Error(
        `${pair.privateKeyName} and ${pair.publicKeyName} must be provided ` +
          'together. Set both env vars, or unset both to let ' +
          'ROOMOTE_AUTO_GENERATE_KEYS manage the keypair.',
      );
    }

    return !hasPrivateKey;
  });

  if (pendingPairs.length === 0) {
    return {};
  }

  const resolved: Record<string, string> = {};

  await executor.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${AUTH_KEYPAIRS_ADVISORY_LOCK_KEY}))`,
    );

    const pendingNames = pendingPairs.flatMap((pair) => [
      pair.privateKeyName,
      pair.publicKeyName,
    ]);
    const rows = await tx.query.deploymentSecrets.findMany({
      where: (deploymentSecrets, { inArray }) =>
        inArray(deploymentSecrets.name, pendingNames),
    });

    const persistedByName = new Map<string, string>();
    for (const row of rows) {
      const decryptedValue = await decryptSecrets<string>(row.value);
      const value =
        typeof decryptedValue === 'string' ? decryptedValue.trim() : '';

      if (value) {
        persistedByName.set(row.name, value);
      }
    }

    for (const pair of pendingPairs) {
      const persistedPrivateKey = persistedByName.get(pair.privateKeyName);
      const persistedPublicKey = persistedByName.get(pair.publicKeyName);

      if (persistedPrivateKey && persistedPublicKey) {
        resolved[pair.privateKeyName] = persistedPrivateKey;
        resolved[pair.publicKeyName] = persistedPublicKey;
        continue;
      }

      if (persistedPrivateKey || persistedPublicKey) {
        throw new Error(
          `deployment_secrets contains an incomplete ${pair.label} keypair ` +
            `(${persistedPrivateKey ? pair.privateKeyName : pair.publicKeyName} ` +
            'without its counterpart). Delete both rows so the keypair can ' +
            'be regenerated, or provide both values via env vars.',
        );
      }

      const generated = generateP256KeypairEnvValues();
      await tx.insert(deploymentSecrets).values([
        { name: pair.privateKeyName, value: generated.privateKey },
        { name: pair.publicKeyName, value: generated.publicKey },
      ]);

      console.info(
        `[auth-keypairs] Generated a new ${pair.label} P-256 keypair and ` +
          'persisted it to deployment_secrets.',
      );

      resolved[pair.privateKeyName] = generated.privateKey;
      resolved[pair.publicKeyName] = generated.publicKey;
    }
  });

  return resolved;
}

/**
 * Boot hook for long-lived services: when `ROOMOTE_AUTO_GENERATE_KEYS=true`,
 * resolve any missing auth keypairs (loading persisted ones or generating
 * new ones), write them into `processEnv`, and rebuild the shared `Env`
 * singleton so lazy consumers observe the resolved keys.
 *
 * On fresh deployments where services boot in parallel with the migration
 * step, the `deployment_secrets` table may not exist yet; that specific
 * failure (Postgres 42P01) is retried with bounded backoff before rethrowing
 * so first boots wait for migrations instead of crash-looping. All other
 * errors fail fast.
 *
 * Returns `true` when any keypair was loaded or generated, `false` when the
 * flag is off or all keys were already provided via env vars.
 */
export async function bootstrapGeneratedAuthKeypairs(
  options: {
    processEnv?: NodeJS.ProcessEnv;
    retryDelaysMs?: number[];
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    ensureKeypairs?: typeof ensureGeneratedAuthKeypairs;
  } = {},
): Promise<boolean> {
  const processEnv = options.processEnv ?? process.env;

  if (!shouldAutoGenerateAuthKeypairs(processEnv)) {
    return false;
  }

  const retryDelaysMs =
    options.retryDelaysMs ?? DEFAULT_MIGRATION_RETRY_DELAYS_MS;
  const log = options.log ?? ((message) => console.info(message));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ensureKeypairs = options.ensureKeypairs ?? ensureGeneratedAuthKeypairs;

  let resolved: Record<string, string>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      resolved = await ensureKeypairs({ processEnv });
      break;
    } catch (error) {
      if (!isMissingRelationError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }

      const delayMs = retryDelaysMs[attempt]!;
      log(
        '[auth-keypairs] deployment_secrets table does not exist yet ' +
          '(waiting for migrations); retrying in ' +
          `${delayMs / 1000}s (attempt ${attempt + 1}/${retryDelaysMs.length}).`,
      );
      await sleep(delayMs);
    }
  }

  if (Object.keys(resolved).length === 0) {
    return false;
  }

  for (const key of AUTH_KEYPAIR_ENV_KEYS) {
    if (resolved[key]) {
      processEnv[key] = resolved[key];
    }
  }

  if (processEnv === process.env) {
    rehydrateEnv(process.env);
  }

  return true;
}
