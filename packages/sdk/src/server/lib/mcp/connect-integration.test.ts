import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  mcpConnections,
  mcpOauthReplays,
  sessionFactory,
  sessions,
  userFactory,
  users,
} from '@roomote/db/server';
import { encrypt } from '@roomote/db/encryption';
import { MCP_INTEGRATIONS } from '@roomote/types';

import {
  getNativeIntegrationSetupStrategy,
  connectIntegrationForFast,
  listNativeIntegrationsForFast,
} from './connect-integration';

const adminId = 'native-integration-admin';
const memberId = 'native-integration-member';
let adminSessionId: string;
let memberSessionId: string;

async function cleanup() {
  await db.delete(mcpOauthReplays).where(eq(mcpOauthReplays.userId, adminId));
  await db.delete(mcpConnections).where(eq(mcpConnections.mcpId, 'granola'));
  await db.delete(mcpConnections).where(eq(mcpConnections.mcpId, 'notion'));
  await db
    .delete(deploymentMcpEnablements)
    .where(eq(deploymentMcpEnablements.mcpId, 'granola'));
  await db
    .delete(deploymentMcpEnablements)
    .where(eq(deploymentMcpEnablements.mcpId, 'notion'));
  await db
    .delete(sessions)
    .where(
      and(eq(sessions.ownerKind, 'user'), eq(sessions.ownerUserId, adminId)),
    );
  await db
    .delete(sessions)
    .where(
      and(eq(sessions.ownerKind, 'user'), eq(sessions.ownerUserId, memberId)),
    );
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(users).where(eq(users.id, memberId));
}

beforeEach(async () => {
  await cleanup();
  await userFactory.create({ id: adminId, role: 'admin' });
  await userFactory.create({ id: memberId, role: 'member' });
  adminSessionId = (
    await sessionFactory.create({ ownerKind: 'user', ownerUserId: adminId })
  ).id;
  memberSessionId = (
    await sessionFactory.create({ ownerKind: 'user', ownerUserId: memberId })
  ).id;
});

afterAll(cleanup);

describe('connectIntegrationForFast', () => {
  it('assigns every built-in integration a Session setup strategy', () => {
    const strategies = Object.fromEntries(
      MCP_INTEGRATIONS.map((integration) => [
        integration.id,
        getNativeIntegrationSetupStrategy(integration),
      ]),
    );

    expect(Object.keys(strategies)).toHaveLength(MCP_INTEGRATIONS.length);
    expect(Object.values(strategies)).not.toContain(undefined);
    expect(strategies).toMatchObject({
      jira: 'oauth',
      monday: 'oauth',
      sentry: 'oauth',
      resend: 'oauth',
      supermemory: 'oauth',
      zero: 'oauth',
      asana: 'settings',
      granola: 'settings',
      snowflake: 'settings',
      voice: 'settings',
      x: 'settings',
      exa: 'keyless',
    });
  });

  it('uses canonical catalog ids for unconfigured native integrations', async () => {
    await expect(
      connectIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integrationId: 'granola',
      }),
    ).resolves.toMatchObject({
      status: 'configuration_required',
      id: 'granola',
      name: 'Granola',
      settingsUrl: expect.stringContaining(
        '/settings/integrations?highlight=granola',
      ),
    });
  });

  it('rejects display names and unknown ids instead of guessing providers', async () => {
    await expect(
      connectIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integrationId: 'Notion',
      }),
    ).rejects.toThrow('Unknown built-in integration: Notion');
    await expect(
      connectIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integrationId: 'unknown-service',
      }),
    ).rejects.toThrow('Unknown built-in integration: unknown-service');
  });

  it('preserves deployment-admin and Session ownership checks', async () => {
    await expect(
      connectIntegrationForFast({
        userId: memberId,
        sessionId: memberSessionId,
        integrationId: 'notion',
      }),
    ).resolves.toMatchObject({ status: 'permission_denied', id: 'notion' });

    await expect(
      connectIntegrationForFast({
        userId: adminId,
        sessionId: memberSessionId,
        integrationId: 'granola',
      }),
    ).resolves.toMatchObject({ status: 'permission_denied', id: 'granola' });
  });

  it('uses the native Notion setup path instead of a generic fallback', async () => {
    await expect(
      connectIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integrationId: 'notion',
      }),
    ).resolves.toMatchObject({
      status: 'operator_configuration_required',
      id: 'notion',
      requiredEnvironmentVariables: [
        'R_NOTION_CLIENT_ID',
        'R_NOTION_CLIENT_SECRET',
      ],
      settingsUrl: expect.stringContaining(
        '/settings/integrations?highlight=notion',
      ),
    });
  });

  it('re-enables an existing authenticated connection idempotently', async () => {
    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: 'granola',
      connectionRole: 'default',
      authConfig: {
        type: 'granola',
        encryptedApiKey: encrypt('granola-key'),
      },
      enabled: false,
      authStatus: 'authenticated',
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        connectIntegrationForFast({
          userId: adminId,
          sessionId: adminSessionId,
          integrationId: 'granola',
        }),
      ).resolves.toEqual({
        status: 'connected',
        id: 'granola',
        name: 'Granola',
      });
    }

    await expect(
      db.query.deploymentMcpEnablements.findFirst({
        where: eq(deploymentMcpEnablements.mcpId, 'granola'),
      }),
    ).resolves.toMatchObject({ enabled: true, enabledByUserId: adminId });
  });

  it('lists every built-in integration and actor-scoped status without changing state', async () => {
    const beforeEnablements =
      await db.query.deploymentMcpEnablements.findMany();
    const catalog = await listNativeIntegrationsForFast({ userId: memberId });

    expect(catalog.map(({ id }) => id)).toEqual(
      MCP_INTEGRATIONS.map(({ id }) => id),
    );
    expect(catalog.find(({ id }) => id === 'notion')).toMatchObject({
      id: 'notion',
      status: 'not_enabled',
      setupStrategy: 'oauth',
      canConnect: false,
    });
    expect(catalog.find(({ id }) => id === 'monday')).toMatchObject({
      id: 'monday',
      status: 'not_enabled',
      setupStrategy: 'oauth',
      canConnect: true,
    });
    expect(await db.query.deploymentMcpEnablements.findMany()).toEqual(
      beforeEnablements,
    );
  });
});
