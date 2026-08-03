import {
  db,
  deploymentMcpEnablements,
  inArray,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { disableAllIntegrationsCommand } from './index';

const TEST_MCP_IDS = ['linear', 'notion'];

describe('disableAllIntegrationsCommand', () => {
  afterEach(async () => {
    await db
      .delete(mcpConnections)
      .where(inArray(mcpConnections.mcpId, TEST_MCP_IDS));
    await db
      .delete(deploymentMcpEnablements)
      .where(inArray(deploymentMcpEnablements.mcpId, TEST_MCP_IDS));
  });

  it('rejects non-admin users', async () => {
    await expect(
      disableAllIntegrationsCommand({ isAdmin: false } as UserAuthSuccess),
    ).rejects.toThrow('Unauthorized');
  });

  it('disables enablements and removes every curated connection', async () => {
    const admin = await userFactory.create({ role: 'admin' });
    const member = await userFactory.create({ role: 'member' });
    await db.insert(deploymentMcpEnablements).values(
      TEST_MCP_IDS.map((mcpId) => ({
        mcpId,
        enabled: true,
        enabledByUserId: admin.id,
      })),
    );
    await db.insert(mcpConnections).values([
      {
        mcpId: 'linear',
        connectionRole: 'linear_org_install',
        authStatus: 'authenticated',
      },
      {
        mcpId: 'linear',
        connectionRole: 'linear_user_link',
        userId: member.id,
        authStatus: 'authenticated',
      },
      {
        mcpId: 'notion',
        userId: member.id,
        authStatus: 'authenticated',
      },
    ]);

    await disableAllIntegrationsCommand({
      userId: admin.id,
      isAdmin: true,
    } as UserAuthSuccess);

    const enablements = await db.query.deploymentMcpEnablements.findMany({
      where: inArray(deploymentMcpEnablements.mcpId, TEST_MCP_IDS),
    });
    const remainingConnections = await db.query.mcpConnections.findMany({
      where: inArray(mcpConnections.mcpId, TEST_MCP_IDS),
    });

    expect(enablements).toHaveLength(2);
    expect(enablements.every((enablement) => !enablement.enabled)).toBe(true);
    expect(
      enablements.every(
        (enablement) => enablement.enabledByUserId === admin.id,
      ),
    ).toBe(true);
    expect(remainingConnections).toEqual([]);
  });
});
