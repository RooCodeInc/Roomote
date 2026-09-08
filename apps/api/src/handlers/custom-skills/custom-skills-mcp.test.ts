import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  db,
  environmentFactory,
  environments,
  eq,
  userFactory,
  users,
} from '@roomote/db/server';
import { registerRoomoteCustomSkillsTool } from '../mcp/roomote-custom-skills-tool';

it('advertises a usable MCP schema and persists through the real actor-authorized route', async () => {
  const admin = await userFactory.create({ role: 'admin' });
  const environment = await environmentFactory.create({
    createdByUserId: admin.id,
    config: {
      name: 'MCP skill creation',
      repositories: [{ repository: 'example/repo' }],
    },
  });
  const server = new McpServer({ name: 'custom-skill-test', version: '1' });
  const client = new Client({ name: 'custom-skill-test', version: '1' });
  try {
    registerRoomoteCustomSkillsTool(server, {
      userId: admin.id,
      authContext: { userId: admin.id, tokenType: 'auth', version: 1 },
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
          required: ['name', 'description', 'content', 'environmentIds'],
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: 'string' }),
            content: expect.objectContaining({ type: 'string' }),
            environmentIds: expect.objectContaining({
              type: 'array',
              minItems: 1,
            }),
          }),
        }),
      }),
    ]);
    const args = {
      name: 'mcp-example-checklist',
      description: ' Review examples ',
      content: 'Check examples.\r\n',
      environmentIds: [environment.id],
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
      (
        await db.query.environments.findFirst({
          where: eq(environments.id, environment.id),
        })
      )?.config.manualSkills,
    ).toEqual([
      {
        name: args.name,
        description: 'Review examples',
        content: 'Check examples.\n',
      },
    ]);
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
    const invalid = await client.callTool({
      name: tools[0]!.name,
      arguments: { ...args, environmentIds: [] },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await db.delete(environments).where(eq(environments.id, environment.id));
    await db.delete(users).where(eq(users.id, admin.id));
  }
});
