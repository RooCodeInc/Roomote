import { createPrivateKey } from 'node:crypto';

import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionSnowflakeConfig } from '@roomote/types';
import snowflakeSdk from 'snowflake-sdk';
import type { Connection, ConnectionOptions } from 'snowflake-sdk';

snowflakeSdk.configure({ logLevel: 'ERROR' });

export type SnowflakeQueryRow = Record<string, unknown>;

interface ResolvedSnowflakeConnectionConfig extends ConnectionOptions {
  role: string;
  warehouse?: string;
}

class SnowflakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnowflakeConfigError';
  }
}

function normalizePrivateKey(
  privateKeyPem: string,
  passphrase: string | undefined,
): string {
  try {
    const trimmedPrivateKey = privateKeyPem.trim();
    if (
      !/^-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(trimmedPrivateKey)
    ) {
      throw new Error('Unsupported private key format');
    }

    const privateKey = createPrivateKey({
      key: trimmedPrivateKey,
      format: 'pem',
      passphrase,
    });
    const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength;

    if (
      privateKey.asymmetricKeyType !== 'rsa' ||
      !modulusLength ||
      modulusLength < 2048
    ) {
      throw new Error('Unsupported private key parameters');
    }

    return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  } catch {
    throw new SnowflakeConfigError(
      'Snowflake private key or passphrase is invalid',
    );
  }
}

function maybeDecryptSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

export function resolveSnowflakeConnectionConfig(
  config: McpConnectionSnowflakeConfig,
): ResolvedSnowflakeConnectionConfig {
  const password = maybeDecryptSecret(config.encryptedPassword);
  const privateKey = maybeDecryptSecret(config.encryptedPrivateKey);
  const privateKeyPass = maybeDecryptSecret(
    config.encryptedPrivateKeyPassphrase,
  );

  if (!password && !privateKey) {
    throw new SnowflakeConfigError(
      'Snowflake connection requires either a password or a private key',
    );
  }

  const authentication = privateKey
    ? {
        authenticator: 'SNOWFLAKE_JWT' as const,
        privateKey: normalizePrivateKey(privateKey, privateKeyPass),
      }
    : { password };

  return {
    account: config.account,
    username: config.username,
    ...authentication,
    role: config.role,
    ...(config.warehouse ? { warehouse: config.warehouse } : {}),
    database: config.database,
    schema: config.schema,
  };
}

function connect(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.connect((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function destroy(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.destroy((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function executeQuery(
  connection: Connection,
  sql: string,
): Promise<SnowflakeQueryRow[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      complete: (error, _statement, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve((rows ?? []) as SnowflakeQueryRow[]);
      },
    });
  });
}

export async function withSnowflakeConnection<T>(
  config: ResolvedSnowflakeConnectionConfig,
  callback: (connection: Connection) => Promise<T>,
): Promise<T> {
  let connection: Connection;

  try {
    connection = snowflakeSdk.createConnection(config);
    await connect(connection);
  } catch {
    throw new Error('Snowflake connection failed');
  }

  try {
    return await callback(connection);
  } finally {
    await destroy(connection).catch(() => undefined);
  }
}
