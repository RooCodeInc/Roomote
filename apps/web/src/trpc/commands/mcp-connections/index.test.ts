import {
  db,
  automationWebhookTriggers,
  customAutomations,
  eq,
  inArray,
  deploymentMcpEnablements,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';
import { TRPCError } from '@trpc/server';

const { captureEventMock } = vi.hoisted(() => ({
  captureEventMock: vi.fn(),
}));

const { getDeploymentStaticOauthReadinessMock } = vi.hoisted(() => ({
  getDeploymentStaticOauthReadinessMock: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: captureEventMock,
}));

vi.mock('@/lib/server/deployment-static-oauth', () => ({
  getDeploymentStaticOauthReadiness: getDeploymentStaticOauthReadinessMock,
}));

import type { UserAuthSuccess } from '@/types';

import {
  connectMcpCommand,
  disconnectMcpCommand,
  saveAsanaConnectionCommand,
  setDeploymentMcpEnabledCommand,
} from './index';

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'mcp-connections-admin',
  isAdmin: true,
} as UserAuthSuccess;

const automationIds: string[] = [];

async function cleanup() {
  if (automationIds.length) {
    await db
      .delete(customAutomations)
      .where(inArray(customAutomations.id, automationIds.splice(0)));
  }
  await db.delete(mcpConnections);
  await db.delete(deploymentMcpEnablements);
}

describe('MCP connection lifecycle telemetry', () => {
  beforeAll(async () => {
    await userFactory.create({ id: adminAuth.userId });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getDeploymentStaticOauthReadinessMock.mockResolvedValue('ready');
    await cleanup();
  });

  afterAll(cleanup);

  async function bindConnection(connectionId: string) {
    const [automation] = await db
      .insert(customAutomations)
      .values({
        name: `mcp-disconnect-${connectionId}`,
        prompt: 'Test connection binding',
      })
      .returning();
    automationIds.push(automation!.id);
    await db.insert(automationWebhookTriggers).values({
      automationId: automation!.id,
      connectionId,
      enabled: false,
      status: 'error',
    });
  }

  const deletePaths = [
    [
      'disconnect',
      (auth: UserAuthSuccess) =>
        disconnectMcpCommand(auth, { mcpId: 'granola' }),
    ],
    [
      'disable',
      (auth: UserAuthSuccess) =>
        setDeploymentMcpEnabledCommand(auth, {
          mcpId: 'granola',
          enabled: false,
        }),
    ],
  ] as const;

  it.each(deletePaths)(
    '%s rejects even inactive bindings without mutations or telemetry',
    async (_name, remove) => {
      const [connection] = await db
        .insert(mcpConnections)
        .values({ mcpId: 'granola' })
        .returning();
      await db
        .insert(deploymentMcpEnablements)
        .values({ mcpId: 'granola', enabled: true });
      await bindConnection(connection!.id);

      const result = remove(adminAuth);
      await expect(result).rejects.toBeInstanceOf(TRPCError);
      await expect(result).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message:
          'Remove automation webhook bindings before disconnecting Granola',
      });
      expect(
        await db.query.mcpConnections.findFirst({
          where: eq(mcpConnections.id, connection!.id),
        }),
      ).toBeDefined();
      expect(
        await db.query.deploymentMcpEnablements.findFirst({
          where: eq(deploymentMcpEnablements.mcpId, 'granola'),
        }),
      ).toMatchObject({ enabled: true });
      expect(captureEventMock).not.toHaveBeenCalled();
    },
  );

  it.each(deletePaths)(
    '%s checks admin authorization before querying bindings',
    async (_name, remove) => {
      const select = vi.spyOn(db, 'select');
      try {
        await expect(remove({ ...adminAuth, isAdmin: false })).rejects.toThrow(
          'Unauthorized',
        );
        expect(select).not.toHaveBeenCalled();
      } finally {
        select.mockRestore();
      }
    },
  );

  it.each(deletePaths)(
    '%s removes an unbound connection despite unrelated bindings',
    async (_name, remove) => {
      const [unrelated] = await db
        .insert(mcpConnections)
        .values({ mcpId: 'asana' })
        .returning();
      await bindConnection(unrelated!.id);
      const [connection] = await db
        .insert(mcpConnections)
        .values({ mcpId: 'granola' })
        .returning();

      await remove(adminAuth);

      expect(
        await db.query.mcpConnections.findFirst({
          where: eq(mcpConnections.id, connection!.id),
        }),
      ).toBeUndefined();
      expect(
        await db.query.mcpConnections.findFirst({
          where: eq(mcpConnections.id, unrelated!.id),
        }),
      ).toBeDefined();
      expect(
        await db.query.deploymentMcpEnablements.findFirst({
          where: eq(deploymentMcpEnablements.mcpId, 'granola'),
        }),
      ).toMatchObject({ enabled: false });
    },
  );

  it('disconnect scopes the precheck to the current user and connection role', async () => {
    const [otherRole] = await db
      .insert(mcpConnections)
      .values({
        mcpId: 'linear',
        userId: null,
        connectionRole: 'linear_org_install',
      })
      .returning();
    await bindConnection(otherRole!.id);
    const otherUser = await userFactory.create();
    const [otherConnection] = await db
      .insert(mcpConnections)
      .values({
        mcpId: 'linear',
        userId: otherUser.id,
        connectionRole: 'linear_user_link',
      })
      .returning();
    await bindConnection(otherConnection!.id);
    await db.insert(mcpConnections).values({
      mcpId: 'linear',
      userId: adminAuth.userId,
      connectionRole: 'linear_user_link',
    });

    await expect(
      disconnectMcpCommand(
        { ...adminAuth, isAdmin: false },
        { mcpId: 'linear', role: 'linear_user_link' },
      ),
    ).resolves.toEqual({ success: true });
    await expect(
      disconnectMcpCommand(
        { ...adminAuth, isAdmin: false },
        { mcpId: 'linear', role: 'linear_user_link' },
      ),
    ).rejects.toThrow('MCP connection not found');
    expect(
      await db.query.mcpConnections.findMany({
        where: eq(mcpConnections.mcpId, 'linear'),
      }),
    ).toHaveLength(2);
  });

  it('deployment disable checks bindings on all user connections before deleting any', async () => {
    const [bound] = await db
      .insert(mcpConnections)
      .values({ mcpId: 'monday', userId: adminAuth.userId })
      .returning();
    await bindConnection(bound!.id);
    await db.insert(mcpConnections).values({ mcpId: 'monday', userId: null });

    await expect(
      setDeploymentMcpEnabledCommand(adminAuth, {
        mcpId: 'monday',
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(
      await db.query.mcpConnections.findMany({
        where: eq(mcpConnections.mcpId, 'monday'),
      }),
    ).toHaveLength(2);
    expect(
      await db.query.deploymentMcpEnablements.findFirst({
        where: eq(deploymentMcpEnablements.mcpId, 'monday'),
      }),
    ).toBeUndefined();
  });

  it('captures deployment enablement changes without connection PII', async () => {
    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'monday',
      enabled: true,
    });
    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'monday',
      enabled: false,
    });

    expect(captureEventMock).toHaveBeenNthCalledWith(1, 'integration_enabled', {
      userId: adminAuth.userId,
      properties: { integration_id: 'monday' },
    });
    expect(captureEventMock).toHaveBeenNthCalledWith(
      2,
      'integration_disabled',
      {
        userId: adminAuth.userId,
        properties: { integration_id: 'monday' },
      },
    );
  });

  it('captures a credential-backed connection only when first connected', async () => {
    await saveAsanaConnectionCommand(adminAuth, { accessToken: 'asana-token' });

    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: adminAuth.userId,
      properties: { integration_id: 'asana' },
    });
    expect(captureEventMock).toHaveBeenCalledWith('integration_enabled', {
      userId: adminAuth.userId,
      properties: { integration_id: 'asana' },
    });

    captureEventMock.mockClear();
    await saveAsanaConnectionCommand(adminAuth, { accessToken: '' });

    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it('keeps Linear identity metadata while restarting authorization', async () => {
    const previousAuthConfig = {
      type: 'oauth_client' as const,
      registered_redirect_uri: 'https://roomote.example/api/mcp-oauth/callback',
      client_id: 'linear-client',
      linearOrganizationId: 'linear-org-1',
      linearOrganizationName: 'Linear Org',
      linearOrganizationUrlKey: 'linear-org',
      appUserId: 'linear-app-user-1',
    };

    const [existing] = await db
      .insert(mcpConnections)
      .values({
        userId: null,
        mcpId: 'linear',
        connectionRole: 'linear_org_install',
        authConfig: previousAuthConfig,
        enabled: true,
        authStatus: 'authenticated',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
      })
      .returning({ id: mcpConnections.id });

    expect(existing).toBeDefined();
    if (!existing) {
      throw new Error('Expected the Linear connection fixture to be created');
    }

    await expect(
      connectMcpCommand(adminAuth, {
        mcpId: 'linear',
        role: 'linear_org_install',
      }),
    ).resolves.toBe(`/api/mcp-oauth/initiate/${existing.id}`);

    const reconnected = await db.query.mcpConnections.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.id, existing.id),
    });

    expect(reconnected).toMatchObject({
      authConfig: previousAuthConfig,
      enabled: false,
      authStatus: 'pending',
    });
    expect(reconnected?.refreshToken).toBeTruthy();
  });
});
