import { createPrivateKey, createPublicKey } from 'node:crypto';

import {
  bootstrapGeneratedAuthKeypairs,
  db,
  deploymentSecrets,
  ensureGeneratedAuthKeypairs,
  inArray,
} from '../../server';
import { decryptSecrets } from '../encryption';

const KEY_NAMES = [
  'JOB_AUTH_PRIVATE_KEY',
  'JOB_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_PRIVATE_KEY',
  'PREVIEW_AUTH_PUBLIC_KEY',
];

function decodePem(value: string | undefined): string {
  expect(value).toBeTruthy();
  return Buffer.from(value!, 'base64').toString('utf-8');
}

async function cleanup() {
  await db
    .delete(deploymentSecrets)
    .where(inArray(deploymentSecrets.name, KEY_NAMES))
    .catch(() => {});
}

describe('ensureGeneratedAuthKeypairs', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('generates valid P-256 keypairs and persists them encrypted', async () => {
    const resolved = await ensureGeneratedAuthKeypairs({ processEnv: {} });

    expect(Object.keys(resolved).sort()).toEqual([...KEY_NAMES].sort());

    const jobPrivatePem = decodePem(resolved.JOB_AUTH_PRIVATE_KEY);
    const jobPublicPem = decodePem(resolved.JOB_AUTH_PUBLIC_KEY);
    expect(jobPrivatePem).toContain('BEGIN PRIVATE KEY');
    expect(jobPublicPem).toContain('BEGIN PUBLIC KEY');

    const privateKey = createPrivateKey(jobPrivatePem);
    const publicKey = createPublicKey(jobPublicPem);
    expect(privateKey.asymmetricKeyType).toBe('ec');
    expect(publicKey.asymmetricKeyType).toBe('ec');
    // The persisted public key must belong to the persisted private key.
    expect(
      createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }),
    ).toEqual(publicKey.export({ format: 'pem', type: 'spki' }));

    const rows = await db.query.deploymentSecrets.findMany({
      where: (deploymentSecrets, { inArray }) =>
        inArray(deploymentSecrets.name, KEY_NAMES),
    });
    expect(rows).toHaveLength(4);

    for (const row of rows) {
      // Stored values are encrypted at rest and decrypt back to the
      // resolved env value.
      expect(row.value).not.toBe(resolved[row.name]);
      await expect(decryptSecrets<string>(row.value)).resolves.toBe(
        resolved[row.name],
      );
    }
  });

  it('returns the same persisted keypairs on subsequent boots', async () => {
    const first = await ensureGeneratedAuthKeypairs({ processEnv: {} });
    const second = await ensureGeneratedAuthKeypairs({ processEnv: {} });

    expect(second).toEqual(first);
  });

  it('skips pairs that are fully provided via env vars', async () => {
    const resolved = await ensureGeneratedAuthKeypairs({
      processEnv: {
        JOB_AUTH_PRIVATE_KEY: 'env-job-private',
        JOB_AUTH_PUBLIC_KEY: 'env-job-public',
      },
    });

    expect(Object.keys(resolved).sort()).toEqual([
      'PREVIEW_AUTH_PRIVATE_KEY',
      'PREVIEW_AUTH_PUBLIC_KEY',
    ]);

    const rows = await db.query.deploymentSecrets.findMany({
      where: (deploymentSecrets, { inArray }) =>
        inArray(deploymentSecrets.name, KEY_NAMES),
    });
    expect(rows.map((row) => row.name).sort()).toEqual([
      'PREVIEW_AUTH_PRIVATE_KEY',
      'PREVIEW_AUTH_PUBLIC_KEY',
    ]);
  });

  it('returns nothing when every pair is provided via env vars', async () => {
    const resolved = await ensureGeneratedAuthKeypairs({
      processEnv: {
        JOB_AUTH_PRIVATE_KEY: 'env-job-private',
        JOB_AUTH_PUBLIC_KEY: 'env-job-public',
        PREVIEW_AUTH_PRIVATE_KEY: 'env-preview-private',
        PREVIEW_AUTH_PUBLIC_KEY: 'env-preview-public',
      },
    });

    expect(resolved).toEqual({});
  });

  it('rejects a half-configured env keypair', async () => {
    await expect(
      ensureGeneratedAuthKeypairs({
        processEnv: { JOB_AUTH_PRIVATE_KEY: 'env-job-private' },
      }),
    ).rejects.toThrow(/JOB_AUTH_PRIVATE_KEY and JOB_AUTH_PUBLIC_KEY/);
  });

  it('rejects an incomplete persisted keypair', async () => {
    await db.insert(deploymentSecrets).values({
      name: 'JOB_AUTH_PRIVATE_KEY',
      value: 'orphaned-private-key',
    });

    await expect(
      ensureGeneratedAuthKeypairs({ processEnv: {} }),
    ).rejects.toThrow(/incomplete JOB_AUTH keypair/);
  });
});

describe('bootstrapGeneratedAuthKeypairs', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('is a no-op in production without ROOMOTE_AUTO_GENERATE_KEYS', async () => {
    const processEnv: NodeJS.ProcessEnv = { R_APP_ENV: 'production' };

    await expect(bootstrapGeneratedAuthKeypairs({ processEnv })).resolves.toBe(
      false,
    );
    expect(processEnv.JOB_AUTH_PRIVATE_KEY).toBeUndefined();

    const rows = await db.query.deploymentSecrets.findMany({
      where: (deploymentSecrets, { inArray }) =>
        inArray(deploymentSecrets.name, KEY_NAMES),
    });
    expect(rows).toHaveLength(0);
  });

  it('auto-generates in development without the explicit flag', async () => {
    const processEnv: NodeJS.ProcessEnv = { R_APP_ENV: 'development' };

    await expect(bootstrapGeneratedAuthKeypairs({ processEnv })).resolves.toBe(
      true,
    );

    for (const name of KEY_NAMES) {
      expect(processEnv[name]).toBeTruthy();
    }
  });

  it('writes resolved keypairs into the process env when enabled', async () => {
    const processEnv: NodeJS.ProcessEnv = {
      ROOMOTE_AUTO_GENERATE_KEYS: 'true',
    };

    await expect(bootstrapGeneratedAuthKeypairs({ processEnv })).resolves.toBe(
      true,
    );

    for (const name of KEY_NAMES) {
      expect(processEnv[name]).toBeTruthy();
    }

    // A second boot loads the same persisted values.
    const secondBootEnv: NodeJS.ProcessEnv = {
      ROOMOTE_AUTO_GENERATE_KEYS: 'true',
    };
    await expect(
      bootstrapGeneratedAuthKeypairs({ processEnv: secondBootEnv }),
    ).resolves.toBe(true);

    for (const name of KEY_NAMES) {
      expect(secondBootEnv[name]).toBe(processEnv[name]);
    }
  });

  it('keeps env-provided keypairs untouched', async () => {
    const processEnv: NodeJS.ProcessEnv = {
      ROOMOTE_AUTO_GENERATE_KEYS: 'true',
      JOB_AUTH_PRIVATE_KEY: 'env-job-private',
      JOB_AUTH_PUBLIC_KEY: 'env-job-public',
      PREVIEW_AUTH_PRIVATE_KEY: 'env-preview-private',
      PREVIEW_AUTH_PUBLIC_KEY: 'env-preview-public',
    };

    await expect(bootstrapGeneratedAuthKeypairs({ processEnv })).resolves.toBe(
      false,
    );
    expect(processEnv.JOB_AUTH_PRIVATE_KEY).toBe('env-job-private');
  });
});

describe('bootstrapGeneratedAuthKeypairs pending-migration retries', () => {
  // The shape drizzle produces when the table has not been migrated yet: a
  // DrizzleQueryError wrapping the postgres.js error that carries the code.
  function missingRelationError(): Error {
    return Object.assign(
      new Error('Failed query: select ... from deployment_secrets'),
      {
        cause: Object.assign(
          new Error('relation "deployment_secrets" does not exist'),
          { code: '42P01' },
        ),
      },
    );
  }

  function makeBootstrapHarness(failures: Error[]) {
    const remainingFailures = [...failures];
    const logs: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;

    return {
      logs,
      sleeps,
      calls: () => calls,
      options: {
        processEnv: {
          ROOMOTE_AUTO_GENERATE_KEYS: 'true',
        } as NodeJS.ProcessEnv,
        log: (message: string) => {
          logs.push(message);
        },
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        ensureKeypairs: async () => {
          calls += 1;
          const failure = remainingFailures.shift();
          if (failure) {
            throw failure;
          }
          return {
            JOB_AUTH_PRIVATE_KEY: 'generated-job-private',
            JOB_AUTH_PUBLIC_KEY: 'generated-job-public',
            PREVIEW_AUTH_PRIVATE_KEY: 'generated-preview-private',
            PREVIEW_AUTH_PUBLIC_KEY: 'generated-preview-public',
          };
        },
      },
    };
  }

  it('retries missing-relation errors until migrations land', async () => {
    const harness = makeBootstrapHarness([
      missingRelationError(),
      missingRelationError(),
    ]);

    await expect(
      bootstrapGeneratedAuthKeypairs({
        ...harness.options,
        retryDelaysMs: [10, 20, 40],
      }),
    ).resolves.toBe(true);

    expect(harness.calls()).toBe(3);
    expect(harness.sleeps).toEqual([10, 20]);
    expect(harness.logs).toHaveLength(2);
    for (const message of harness.logs) {
      expect(message).toContain('[auth-keypairs]');
      expect(message).toContain('waiting for migrations');
    }
    expect(harness.options.processEnv.JOB_AUTH_PRIVATE_KEY).toBe(
      'generated-job-private',
    );
  });

  it('retries when the Postgres code is on the error itself', async () => {
    const harness = makeBootstrapHarness([
      Object.assign(new Error('relation "deployment_secrets" does not exist'), {
        code: '42P01',
      }),
    ]);

    await expect(
      bootstrapGeneratedAuthKeypairs({
        ...harness.options,
        retryDelaysMs: [10],
      }),
    ).resolves.toBe(true);
    expect(harness.sleeps).toEqual([10]);
  });

  it('rethrows once the retry budget is exhausted', async () => {
    const harness = makeBootstrapHarness([
      missingRelationError(),
      missingRelationError(),
      missingRelationError(),
    ]);

    await expect(
      bootstrapGeneratedAuthKeypairs({
        ...harness.options,
        retryDelaysMs: [10, 20],
      }),
    ).rejects.toThrow(/deployment_secrets/);

    expect(harness.calls()).toBe(3);
    expect(harness.sleeps).toEqual([10, 20]);
  });

  it('fails fast on non-migration errors', async () => {
    const harness = makeBootstrapHarness([
      Object.assign(new Error('password authentication failed'), {
        cause: Object.assign(new Error('auth failed'), { code: '28P01' }),
      }),
    ]);

    await expect(
      bootstrapGeneratedAuthKeypairs({
        ...harness.options,
        retryDelaysMs: [10, 20],
      }),
    ).rejects.toThrow(/password authentication failed/);

    expect(harness.calls()).toBe(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.logs).toEqual([]);
  });
});
