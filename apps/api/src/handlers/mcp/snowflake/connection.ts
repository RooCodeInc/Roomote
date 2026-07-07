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

  return {
    account: config.account,
    username: config.username,
    ...(privateKey
      ? { authenticator: 'SNOWFLAKE_JWT' as const }
      : { password }),
    privateKey,
    privateKeyPass,
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
  const connection = snowflakeSdk.createConnection(config);

  await connect(connection);

  try {
    return await callback(connection);
  } finally {
    await destroy(connection).catch(() => undefined);
  }
}
