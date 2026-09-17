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
  setupNativeIntegrationForFast,
} from './setup-native-integration';

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

describe('setupNativeIntegrationForFast', () => {
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

  it('distinguishes unsupported services from unconfigured native integrations', async () => {
    await expect(
      setupNativeIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integration: 'unknown-service',
      }),
    ).resolves.toEqual({
      status: 'unsupported',
      name: 'unknown-service',
    });

    await expect(
      setupNativeIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integration: 'Granola',
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

  it('preserves deployment-admin and Session ownership checks', async () => {
    await expect(
      setupNativeIntegrationForFast({
        userId: memberId,
        sessionId: memberSessionId,
        integration: 'notion',
      }),
    ).resolves.toMatchObject({ status: 'permission_denied', id: 'notion' });

    await expect(
      setupNativeIntegrationForFast({
        userId: adminId,
        sessionId: memberSessionId,
        integration: 'granola',
      }),
    ).resolves.toMatchObject({ status: 'permission_denied', id: 'granola' });
  });

  it('uses the native Notion setup path instead of a generic fallback', async () => {
    await expect(
      setupNativeIntegrationForFast({
        userId: adminId,
        sessionId: adminSessionId,
        integration: 'Notion',
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
        setupNativeIntegrationForFast({
          userId: adminId,
          sessionId: adminSessionId,
          integration: 'granola',
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
});
