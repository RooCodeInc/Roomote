import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  resetSecretProvider,
  setSecretProvider,
  type SecretName,
} from '@roomote/env';

import { db, type DatabaseOrTransaction } from '../../db';
import { userFactory } from '../../fixtures/factories/user.factory';
import {
  customMcpServers,
  deploymentSecrets,
  environmentVariables,
  fastAgentConversations,
  fastAgentPersonalizationSnapshots,
  mcpConnections,
  userApiKeys,
} from '../../schema';
import { decryptWithKeyGeneration, encrypt, encryptJSON } from '../encryption';
import {
  discoverEncryptedColumnLocations,
  listEncryptedLocations,
  reencryptSecrets,
  type LocationReport,
  type ReencryptSecretsReport,
} from '../reencrypt-secrets';

const OLD_KEY = 'old-encryption-key-0000000000000000';
const NEW_KEY = 'new-encryption-key-1111111111111111';
const OTHER_KEY = 'other-encryption-key-22222222222222';

function useKeys(keys: Partial<Record<SecretName, string>>) {
  setSecretProvider({ getSecret: (name) => keys[name] });
}

function useRotatedKeys() {
  useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });
}

function encryptWith(key: string, text: string): string {
  useKeys({ ENCRYPTION_KEY: key });
  try {
    return encrypt(text);
  } finally {
    resetSecretProvider();
  }
}

function keyOf(ciphertext: string): string {
  return decryptWithKeyGeneration(ciphertext).key;
}

function location(
  report: ReencryptSecretsReport,
  table: string,
  column: string,
): LocationReport {
  const found = report.locations.find(
    (entry) => entry.table === table && entry.column === column,
  );
  if (!found) {
    throw new Error(`missing report for ${table}.${column}`);
  }
  return found;
}

function counts(entry: LocationReport) {
  const { scanned, current, migrated, unreadable, notEncrypted, conflicts } =
    entry;
  return { scanned, current, migrated, unreadable, notEncrypted, conflicts };
}

/**
 * Seeds pre-rotation data: everything is written while OLD_KEY is the only
 * key, as a deployment would have stored it before rotating.
 */
async function seedPreRotationData() {
  const [user, otherUser] = await Promise.all([
    userFactory.create(),
    userFactory.create(),
  ]);

  useKeys({ ENCRYPTION_KEY: OLD_KEY });

  // encryptedText column: two rows on the old key.
  await db.insert(userApiKeys).values([
    { userId: user.id, provider: 'anthropic', apiKey: 'sk-old-anthropic' },
    { userId: user.id, provider: 'openai', apiKey: 'sk-old-openai' },
  ]);

  // encryptedJson column.
  await db.insert(environmentVariables).values({
    name: 'ROTATION_TEST_VAR',
    value: 'env-secret',
  });

  // Composite primary key table.
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: 'web',
      workspaceId: 'reencrypt-secrets-test',
      conversationId: crypto.randomUUID(),
    })
    .returning({ id: fastAgentConversations.id });
  await db.insert(fastAgentPersonalizationSnapshots).values({
    conversationId: conversation!.id,
    userId: user.id,
    displayName: 'Ada',
    instructions: 'Be brief.',
    learnFromConversations: true,
  });

  // Manual ciphertext in jsonb fields plus encryptedText token columns.
  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: user.id,
      mcpId: 'granola',
      authConfig: {
        type: 'granola',
        encryptedApiKey: encrypt('granola-key'),
      } as never,
      accessToken: 'mcp-access-token',
      refreshToken: 'mcp-refresh-token',
    })
    .returning({ id: mcpConnections.id });
  // A number beyond JavaScript's safe-integer range must survive the in-SQL
  // jsonb rewrite untouched.
  await db.execute(
    sql`UPDATE mcp_connections SET auth_config = jsonb_set(auth_config, '{accountNumber}', '9007199254740993'::jsonb) WHERE id = ${connection!.id}`,
  );

  const [server] = await db
    .insert(customMcpServers)
    .values({
      name: 'rotation-test-server',
      url: 'https://mcp.example.com',
      headers: {
        Authorization: encrypt('Bearer header-secret'),
        'X-Team': encrypt('team-secret'),
      },
      stdio: null,
    })
    .returning({ id: customMcpServers.id });

  const [stdioServer] = await db
    .insert(customMcpServers)
    .values({
      name: 'rotation-test-stdio-server',
      stdio: {
        command: 'npx',
        args: ['some-mcp'],
        env: { API_TOKEN: encrypt('stdio-secret') },
      },
    })
    .returning({ id: customMcpServers.id });

  resetSecretProvider();

  // A row already on the new key and a row encrypted with an unrelated key.
  useKeys({ ENCRYPTION_KEY: NEW_KEY });
  await db.insert(userApiKeys).values({
    userId: otherUser.id,
    provider: 'anthropic',
    apiKey: 'sk-new',
  });
  resetSecretProvider();
  const [unreadable] = await db
    .insert(userApiKeys)
    .values({
      userId: otherUser.id,
      provider: 'openai',
      apiKey: 'placeholder',
    })
    .returning({ id: userApiKeys.id });
  const foreignCiphertext = encryptWith(OTHER_KEY, 'sk-foreign');
  await db.execute(
    sql`UPDATE user_api_keys SET api_key = ${foreignCiphertext} WHERE id = ${unreadable!.id}`,
  );

  // Legacy plaintext in an encrypted column (pre-encryption leftover).
  await db.execute(
    sql`INSERT INTO environment_variables (name, value) VALUES ('ROTATION_TEST_PLAIN', '"plain-value"')`,
  );

  return {
    connectionId: connection!.id,
    serverId: server!.id,
    stdioServerId: stdioServer!.id,
    unreadableId: unreadable!.id,
    foreignCiphertext,
  };
}

describe('reencryptSecrets', () => {
  beforeEach(async () => {
    // The suite shares one database across files, so clear the tables whose
    // counts these tests assert on.
    await db.delete(userApiKeys);
    await db.delete(environmentVariables);
    await db.delete(fastAgentPersonalizationSnapshots);
    await db.delete(mcpConnections);
    await db.delete(customMcpServers);
    await db.delete(deploymentSecrets);
  });

  afterEach(() => {
    resetSecretProvider();
  });

  it('discovers every encrypted column in the schema', () => {
    const discovered = discoverEncryptedColumnLocations().map(
      (entry) => `${entry.table}.${entry.column}`,
    );

    expect(discovered).toEqual(
      expect.arrayContaining([
        'user_api_keys.api_key',
        'environment_variables.value',
        'deployment_secrets.value',
        'service_credentials.value',
        'mcp_connections.access_token',
        'mcp_connections.refresh_token',
        'fast_agent_personalization_snapshots.instructions',
      ]),
    );
    expect(
      discoverEncryptedColumnLocations().find(
        (entry) => entry.table === 'fast_agent_personalization_snapshots',
      )?.primaryKey,
    ).toEqual(['conversation_id', 'user_id']);
    // Plain jsonb columns with manual ciphertext are listed explicitly.
    expect(
      listEncryptedLocations().map((entry) => `${entry.table}.${entry.column}`),
    ).toEqual(
      expect.arrayContaining([
        'mcp_connections.auth_config',
        'custom_mcp_servers.headers',
        'custom_mcp_servers.stdio',
        'personal_mcp_servers.headers',
      ]),
    );
  });

  it('reports, migrates, and then verifies a rotation', async () => {
    const seeded = await seedPreRotationData();

    useRotatedKeys();

    // Dry run: counts what would change and writes nothing.
    const dryRun = await reencryptSecrets({ dryRun: true, batchSize: 1 });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.previousKeyConfigured).toBe(true);
    expect(counts(location(dryRun, 'user_api_keys', 'api_key'))).toEqual({
      scanned: 4,
      current: 1,
      migrated: 2,
      unreadable: 1,
      notEncrypted: 0,
      conflicts: 0,
    });
    expect(
      counts(location(dryRun, 'environment_variables', 'value')),
    ).toMatchObject({ scanned: 2, migrated: 1, notEncrypted: 1 });
    expect(
      location(dryRun, 'fast_agent_personalization_snapshots', 'instructions')
        .migrated,
    ).toBe(1);
    expect(location(dryRun, 'mcp_connections', 'auth_config').migrated).toBe(1);
    expect(location(dryRun, 'custom_mcp_servers', 'headers').migrated).toBe(1);
    expect(location(dryRun, 'custom_mcp_servers', 'stdio').migrated).toBe(1);
    expect(dryRun.remainingOnPreviousKey).toBe(dryRun.totals.migrated);

    const untouched = await db.query.userApiKeys.findMany();
    expect(
      untouched
        .filter((row) => row.id !== seeded.unreadableId)
        .map((row) => keyOf(row.apiKey!)),
    ).toEqual(expect.arrayContaining(['previous', 'previous', 'current']));

    // Real run, in small batches to exercise keyset paging.
    const live = await reencryptSecrets({ batchSize: 1 });

    expect(live.dryRun).toBe(false);
    expect(live.totals.migrated).toBe(dryRun.totals.migrated);
    expect(live.totals.conflicts).toBe(0);
    expect(live.remainingOnPreviousKey).toBe(0);
    expect(location(live, 'user_api_keys', 'api_key').unreadable).toBe(1);

    // Every readable value now opens with the current key alone.
    useKeys({ ENCRYPTION_KEY: NEW_KEY });

    const apiKeys = await db.query.userApiKeys.findMany();
    const readable = apiKeys.filter((row) => row.id !== seeded.unreadableId);
    expect(
      readable.map((row) => decryptWithKeyGeneration(row.apiKey!).plaintext),
    ).toEqual(
      expect.arrayContaining(['sk-old-anthropic', 'sk-old-openai', 'sk-new']),
    );
    expect(readable.every((row) => keyOf(row.apiKey!) === 'current')).toBe(
      true,
    );
    // Unreadable values are left exactly as they were.
    expect(apiKeys.find((row) => row.id === seeded.unreadableId)?.apiKey).toBe(
      seeded.foreignCiphertext,
    );

    const envVar = await db.query.environmentVariables.findFirst({
      where: eq(environmentVariables.name, 'ROTATION_TEST_VAR'),
    });
    expect(JSON.parse(decryptWithKeyGeneration(envVar!.value!).plaintext)).toBe(
      'env-secret',
    );
    const plainVar = await db.query.environmentVariables.findFirst({
      where: eq(environmentVariables.name, 'ROTATION_TEST_PLAIN'),
    });
    expect(plainVar!.value).toBe('"plain-value"');

    const snapshot =
      await db.query.fastAgentPersonalizationSnapshots.findFirst();
    expect(decryptWithKeyGeneration(snapshot!.instructions!).plaintext).toBe(
      'Be brief.',
    );
    expect(decryptWithKeyGeneration(snapshot!.displayName!).plaintext).toBe(
      'Ada',
    );

    const connection = await db.query.mcpConnections.findFirst({
      where: eq(mcpConnections.id, seeded.connectionId),
    });
    const authConfig = connection!.authConfig as unknown as Record<
      string,
      unknown
    >;
    expect(
      decryptWithKeyGeneration(authConfig.encryptedApiKey as string).plaintext,
    ).toBe('granola-key');
    expect(authConfig.type).toBe('granola');
    expect(decryptWithKeyGeneration(connection!.accessToken!).plaintext).toBe(
      'mcp-access-token',
    );
    const [rawAuthConfig] = await db.execute<{ account: string }>(
      sql`SELECT auth_config->>'accountNumber' AS account FROM mcp_connections WHERE id = ${seeded.connectionId}`,
    );
    expect(rawAuthConfig!.account).toBe('9007199254740993');

    const server = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, seeded.serverId),
    });
    expect(
      Object.fromEntries(
        Object.entries(server!.headers!).map(([name, value]) => [
          name,
          decryptWithKeyGeneration(value).plaintext,
        ]),
      ),
    ).toEqual({
      Authorization: 'Bearer header-secret',
      'X-Team': 'team-secret',
    });

    const stdioServer = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, seeded.stdioServerId),
    });
    expect(stdioServer!.stdio!.command).toBe('npx');
    expect(stdioServer!.stdio!.args).toEqual(['some-mcp']);
    expect(
      decryptWithKeyGeneration(stdioServer!.stdio!.env!.API_TOKEN!).plaintext,
    ).toBe('stdio-secret');

    // Idempotent: a second run finds nothing left to migrate.
    useRotatedKeys();
    const again = await reencryptSecrets();
    expect(again.totals.migrated).toBe(0);
    expect(again.remainingOnPreviousKey).toBe(0);
    expect(location(again, 'user_api_keys', 'api_key')).toMatchObject({
      current: 3,
      unreadable: 1,
    });
  });

  it('migrates readable values in a row that also holds an unreadable one', async () => {
    // Two headers on one server: one only the previous key opens, one
    // neither key opens. The row must not hide the pending previous-key
    // value behind its unreadable status.
    const previousHeader = encryptWith(OLD_KEY, 'Bearer still-readable');
    const foreignHeader = encryptWith(OTHER_KEY, 'Bearer lost');
    const [server] = await db
      .insert(customMcpServers)
      .values({
        name: 'rotation-test-mixed-headers',
        url: 'https://mcp.example.com',
        headers: { Authorization: previousHeader, 'X-Lost': foreignHeader },
      })
      .returning({ id: customMcpServers.id });
    const headersOnly = listEncryptedLocations().filter(
      (entry) =>
        entry.table === 'custom_mcp_servers' && entry.column === 'headers',
    );

    useRotatedKeys();

    const dryRun = await reencryptSecrets({
      dryRun: true,
      locations: headersOnly,
    });
    expect(counts(location(dryRun, 'custom_mcp_servers', 'headers'))).toEqual({
      scanned: 1,
      current: 0,
      migrated: 1,
      unreadable: 1,
      notEncrypted: 0,
      conflicts: 0,
    });
    expect(dryRun.remainingOnPreviousKey).toBe(1);

    const live = await reencryptSecrets({ locations: headersOnly });
    expect(location(live, 'custom_mcp_servers', 'headers')).toMatchObject({
      migrated: 1,
      unreadable: 1,
      remainingOnPreviousKey: 0,
    });
    expect(live.remainingOnPreviousKey).toBe(0);

    useKeys({ ENCRYPTION_KEY: NEW_KEY });
    const stored = await db.query.customMcpServers.findFirst({
      where: eq(customMcpServers.id, server!.id),
    });
    expect(decryptWithKeyGeneration(stored!.headers!.Authorization!)).toEqual({
      plaintext: 'Bearer still-readable',
      key: 'current',
    });
    // The unreadable value is left byte-for-byte as it was.
    expect(stored!.headers!['X-Lost']).toBe(foreignHeader);

    // Nothing left on the previous key now; the unreadable value remains.
    useRotatedKeys();
    const again = await reencryptSecrets({
      dryRun: true,
      locations: headersOnly,
    });
    expect(location(again, 'custom_mcp_servers', 'headers')).toMatchObject({
      migrated: 0,
      unreadable: 1,
      remainingOnPreviousKey: 0,
    });
  });

  it('skips a row that changed after it was read', async () => {
    const user = await userFactory.create();
    useKeys({ ENCRYPTION_KEY: OLD_KEY });
    await db.insert(userApiKeys).values({
      userId: user.id,
      provider: 'anthropic',
      apiKey: 'sk-old',
    });

    useRotatedKeys();

    // Simulate a concurrent application write landing between the read and
    // the compare-and-swap rewrite: the writer's value must win.
    const concurrentValue = encrypt('sk-written-concurrently');
    const dialect = new PgDialect();
    const racingDb = {
      execute: async (query: SQL) => {
        if (dialect.sqlToQuery(query).sql.includes('UPDATE')) {
          await db.execute(
            sql`UPDATE user_api_keys SET api_key = ${concurrentValue} WHERE user_id = ${user.id}`,
          );
        }
        return db.execute(query);
      },
    } as unknown as DatabaseOrTransaction;

    const report = await reencryptSecrets({
      db: racingDb,
      locations: listEncryptedLocations().filter(
        (entry) => entry.table === 'user_api_keys',
      ),
    });

    expect(counts(location(report, 'user_api_keys', 'api_key'))).toEqual({
      scanned: 1,
      current: 0,
      migrated: 0,
      unreadable: 0,
      notEncrypted: 0,
      conflicts: 1,
    });
    expect(report.remainingOnPreviousKey).toBe(1);

    const row = await db.query.userApiKeys.findFirst({
      where: eq(userApiKeys.userId, user.id),
    });
    expect(row!.apiKey).toBe(concurrentValue);
  });

  it('reports a missing column instead of failing', async () => {
    const report = await reencryptSecrets({
      locations: [
        {
          table: 'table_that_does_not_exist',
          column: 'value',
          primaryKey: ['id'],
          shape: { kind: 'ciphertext' },
        },
      ],
    });

    expect(report.locations[0]!.skipped).toMatch(/not present/);
  });

  it('leaves encryptJSON object payloads readable', async () => {
    useKeys({ ENCRYPTION_KEY: OLD_KEY });
    const stored = encryptJSON({ token: 'abc' });
    resetSecretProvider();
    await db.execute(
      sql`INSERT INTO deployment_secrets (name, value) VALUES ('ROTATION_TEST_OBJECT', ${stored})`,
    );

    useRotatedKeys();
    const report = await reencryptSecrets({
      locations: listEncryptedLocations().filter(
        (entry) => entry.table === 'deployment_secrets',
      ),
    });
    expect(location(report, 'deployment_secrets', 'value').migrated).toBe(1);

    useKeys({ ENCRYPTION_KEY: NEW_KEY });
    const [row] = await db.execute<{ value: string }>(
      sql`SELECT value FROM deployment_secrets WHERE name = 'ROTATION_TEST_OBJECT'`,
    );
    expect(JSON.parse(decryptWithKeyGeneration(row!.value).plaintext)).toEqual({
      token: 'abc',
    });
  });
});
