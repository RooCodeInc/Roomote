import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { RoomoteTaskClient } from './roomote-client.js';
import { createRoomoteMcpServer, createToolHandlers } from './server.js';

const result: CallToolResult = {
  content: [{ type: 'text', text: '{"success":true}' }],
};

function createClient() {
  return {
    callManageTasks: vi.fn().mockResolvedValue(result),
    close: vi.fn(),
  } satisfies RoomoteTaskClient;
}

describe('Roomote stdio tool handlers', () => {
  it('exposes the focused task-management tool set', async () => {
    const roomoteClient = createClient();
    const server = createRoomoteMcpServer(roomoteClient);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    try {
      const tools = await mcpClient.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'list_environments',
        'launch_task',
        'get_task_status',
        'send_follow_up',
      ]);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it('lists environments through the hosted Roomote MCP', async () => {
    const client = createClient();

    await expect(createToolHandlers(client).listEnvironments()).resolves.toBe(
      result,
    );
    expect(client.callManageTasks).toHaveBeenCalledWith({
      action: 'list_environments',
    });
  });

  it('launches a task with the selected environment', async () => {
    const client = createClient();
    const params = {
      prompt: 'Investigate the failing build',
      environmentId: 'environment-1',
      branch: 'feature/build-fix',
      notifyOnSettle: true,
    };

    await createToolHandlers(client).launchTask(params);

    expect(client.callManageTasks).toHaveBeenCalledWith({
      action: 'launch',
      ...params,
    });
  });

  it('gets a task summary by task ID', async () => {
    const client = createClient();

    await createToolHandlers(client).getTaskStatus({ taskId: 'task-1' });

    expect(client.callManageTasks).toHaveBeenCalledWith({
      action: 'get_summary',
      taskId: 'task-1',
    });
  });

  it('sends a follow-up message', async () => {
    const client = createClient();

    await createToolHandlers(client).sendFollowUp({
      taskId: 'task-1',
      message: 'Add a regression test',
    });

    expect(client.callManageTasks).toHaveBeenCalledWith({
      action: 'send_message',
      taskId: 'task-1',
      message: 'Add a regression test',
    });
  });
});
