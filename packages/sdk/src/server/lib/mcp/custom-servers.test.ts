import {
  customMcpServers,
  db,
  eq,
  inArray,
  personalMcpServers,
  userFactory,
  users,
} from '@roomote/db/server';

import {
  canManageCustomMcpServer,
  findCustomMcpServerById,
} from './custom-servers';

const ownerId = 'custom-servers-owner';
const creatorId = 'custom-servers-creator';
const userIds = [ownerId, creatorId];

async function cleanup() {
  await db
    .delete(customMcpServers)
    .where(inArray(customMcpServers.createdByUserId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}

describe('custom MCP server resolution', () => {
  beforeEach(async () => {
    await cleanup();
    for (const id of userIds) await userFactory.create({ id });
  });
  afterAll(cleanup);

  it('resolves a deployment server with no owner and its creator', async () => {
    const [row] = await db
      .insert(customMcpServers)
      .values({
        name: 'custom-servers-shared',
        url: 'https://mcp.example.com/mcp',
        createdByUserId: creatorId,
      })
      .returning({ id: customMcpServers.id });

    expect(await findCustomMcpServerById(row!.id)).toMatchObject({
      ownerUserId: null,
      createdByUserId: creatorId,
      isStdio: false,
    });
  });

  it('resolves a personal server to its owner, and treats a deactivated owner as gone', async () => {
    const [row] = await db
      .insert(personalMcpServers)
      .values({
        ownerUserId: ownerId,
        name: 'mine',
        url: 'https://mcp.example.com/mcp',
      })
      .returning({ id: personalMcpServers.id });

    expect(await findCustomMcpServerById(row!.id)).toMatchObject({
      ownerUserId: ownerId,
      createdByUserId: ownerId,
    });

    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, ownerId));

    expect(await findCustomMcpServerById(row!.id)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await findCustomMcpServerById(crypto.randomUUID())).toBeNull();
  });
});

describe('canManageCustomMcpServer', () => {
  const personal = { ownerUserId: ownerId, createdByUserId: ownerId };
  const shared = { ownerUserId: null, createdByUserId: creatorId };

  it('gives a personal server to its owner alone, administrators included', () => {
    expect(
      canManageCustomMcpServer(personal, { userId: ownerId, isAdmin: false }),
    ).toBe(true);
    expect(
      canManageCustomMcpServer(personal, { userId: 'admin', isAdmin: true }),
    ).toBe(false);
  });

  it('gives a shared server to administrators and the member who added it', () => {
    expect(
      canManageCustomMcpServer(shared, { userId: creatorId, isAdmin: false }),
    ).toBe(true);
    expect(
      canManageCustomMcpServer(shared, { userId: 'admin', isAdmin: true }),
    ).toBe(true);
    expect(
      canManageCustomMcpServer(shared, { userId: 'other', isAdmin: false }),
    ).toBe(false);
    expect(
      canManageCustomMcpServer(
        { ownerUserId: null, createdByUserId: null },
        { userId: 'other', isAdmin: false },
      ),
    ).toBe(false);
  });
});
