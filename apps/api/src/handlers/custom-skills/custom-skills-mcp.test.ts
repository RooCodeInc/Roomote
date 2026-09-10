import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db, instanceSkills, eq, userFactory, users } from '@roomote/db/server';
import { registerRoomoteCustomSkillsTool } from '../mcp/roomote-custom-skills-tool';

it('advertises a usable MCP schema and persists through the real actor-authorized route', async () => {
  const member = await userFactory.create({ role: 'member' });
  const name = `mcp-checklist-${member.id}`;
  const server = new McpServer({ name: 'custom-skill-test', version: '1' });
  const client = new Client({ name: 'custom-skill-test', version: '1' });
  try {
    registerRoomoteCustomSkillsTool(server, {
      userId: member.id,
      authContext: { userId: member.id, tokenType: 'auth', version: 1 },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'create_custom_skill',
        inputSchema: expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description', 'content'],
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: 'string' }),
            description: expect.objectContaining({ type: 'string' }),
            content: expect.objectContaining({ type: 'string' }),
          }),
        }),
      }),
    ]);
    expect(Object.keys(tools[0]!.inputSchema.properties!)).toEqual([
      'name',
      'description',
      'content',
    ]);
    const args = {
      name,
      description: ' Review examples ',
      content: 'Check examples.\r\n',
    };
    const created = await client.callTool({
      name: tools[0]!.name,
      arguments: args,
    });
    expect(created.isError).not.toBe(true);
    expect(created.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"persisted": true'),
      }),
    ]);
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, name),
      }),
    ).toMatchObject({
      name: args.name,
      description: 'Review examples',
      content: 'Check examples.\n',
      createdByUserId: member.id,
    });
    const duplicate = await client.callTool({
      name: tools[0]!.name,
      arguments: args,
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"status": 409'),
      }),
    ]);
    for (const extra of [
      { environmentIds: [] },
      { environmentId: 'environment' },
      { workspaceId: 'workspace' },
      { createdByUserId: member.id },
    ]) {
      const invalid = await client.callTool({
        name: tools[0]!.name,
        arguments: { ...args, name: `${name}-invalid`, ...extra },
      });
      expect(invalid.isError).toBe(true);
    }
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, `${name}-invalid`),
      }),
    ).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
    await db
      .delete(instanceSkills)
      .where(eq(instanceSkills.createdByUserId, member.id));
    await db.delete(users).where(eq(users.id, member.id));
  }
});
