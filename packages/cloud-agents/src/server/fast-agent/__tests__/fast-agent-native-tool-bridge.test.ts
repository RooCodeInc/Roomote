import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALL_REPOSITORIES } from '@roomote/types';

import {
  bindFastAgentMcpToolExecutor,
  bindFastAgentNativeToolExecutor,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
  getFastAgentNativeToolRuntime,
} from '../fast-agent-native-tool-bridge';
import { callMcpTool, listMcpTools } from '../../mcp-tool-client';

describe('Fast native OpenCode tool bridge', () => {
  it('installs Fast tools in an isolated OpenCode session directory', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-files', []);
    const toolsDirectory = join(runtime.directory, '.opencode', 'tools');
    const installedToolFiles = await readdir(toolsDirectory);
    const replySource = await readFile(
      join(toolsDirectory, 'send_chat_reply.js'),
      'utf8',
    );
    const launchTaskSource = await readFile(
      join(toolsDirectory, 'launch_task.js'),
      'utf8',
    );
    const bridgeSource = await readFile(
      join(runtime.directory, '.opencode', 'roomote-fast-tool-bridge.js'),
      'utf8',
    );

    expect(installedToolFiles.sort()).toEqual(
      Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)
        .map((name) => `${name}.js`)
        .sort(),
    );
    expect(replySource).toContain('export default {');
    expect(replySource).toContain('invoke("send_chat_reply"');
    expect(replySource).toContain('suggestions: z.array');
    expect(replySource).toContain('Launchable follow-ups');
    expect(launchTaskSource).toContain('model: z.string().min(1)');
    expect(launchTaskSource).toContain('deployment-enabled model ID');
    expect(launchTaskSource).toContain(ALL_REPOSITORIES);
    expect(launchTaskSource).toContain(
      'to run against all active repositories',
    );
    expect(installedToolFiles).not.toEqual(
      expect.arrayContaining([
        'get_chat_channel_messages.js',
        'get_chat_message_context.js',
        'integration_call.js',
        'manage_tasks.js',
      ]),
    );
    expect(bridgeSource).toContain('context.sessionID');
    expect(bridgeSource).toContain('agent: context.agent');
    expect(bridgeSource).toContain('metadata: { roomoteResult:');
    expect(FAST_AGENT_NATIVE_TOOL_FILTER).toMatchObject({
      '*': false,
      task: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: true,
    });
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER).toMatchObject({
      '*': true,
      task: false,
      roomote_manage_custom_automations: false,
    });
    for (const parentOnlyTool of [
      FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      FAST_AGENT_NATIVE_TOOL_NAMES.launchTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage,
    ]) {
      expect(FAST_AGENT_SUBAGENT_TOOL_FILTER[parentOnlyTool]).not.toBe(true);
    }
  });

  it('mounts actor-resolved MCP tools with their native JSON schemas', async () => {
    const inputSchema = {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 2 },
        filters: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'null' },
          ],
        },
      },
      required: ['query'],
      additionalProperties: false,
    };
    const runtime = await getFastAgentNativeToolRuntime('native-mcp', [
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: [
          { name: 'search_code', description: 'Search code', inputSchema },
        ],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const executor = vi.fn(async ({ args }) => ({ matches: [args.query] }));
    expect(config.mcp.github!.headers.Authorization).toBe(
      `Bearer ${runtime.mcpCapability}`,
    );
    expect(config.mcp.github!.headers.Authorization).not.toContain(
      runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN,
    );
    const unbind = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      executor,
    );

    try {
      await expect(
        listMcpTools({
          url: config.mcp.github!.url,
          headers: config.mcp.github!.headers,
        }),
      ).resolves.toEqual([
        { name: 'search_code', description: 'Search code', inputSchema },
      ]);
      await expect(
        callMcpTool({
          url: config.mcp.github!.url,
          headers: config.mcp.github!.headers,
          toolName: 'search_code',
          args: { query: 'Fast', filters: null },
        }),
      ).resolves.toEqual({ matches: ['Fast'] });
      expect(executor).toHaveBeenCalledWith({
        integrationId: 'github',
        toolName: 'search_code',
        args: { query: 'Fast', filters: null },
      });
    } finally {
      unbind();
    }
  });

  it('routes raw JSON arguments and results by OpenCode session id', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-route', []);
    const executor = vi.fn(async ({ agent, name, args }) => ({
      agent,
      name,
      echoed: args,
      nestedResult: { values: [1, 2, 3] },
    }));
    const unbind = bindFastAgentNativeToolExecutor(
      'opencode-session-1',
      executor,
    );

    try {
      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: 'opencode-session-1',
          agent: 'judge',
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          args: { reason: 'test' },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          agent: 'judge',
          name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          echoed: { reason: 'test' },
          nestedResult: { values: [1, 2, 3] },
        },
      });
      expect(executor).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'judge' }),
      );
    } finally {
      unbind();
    }
  });

  it('does not expose unexpected executor errors through the bridge', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-errors', []);
    const unbind = bindFastAgentNativeToolExecutor(
      'opencode-session-sensitive-error',
      async () => {
        throw new Error('database password appeared in a downstream stack');
      },
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: 'opencode-session-sensitive-error',
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          args: {},
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'Fast tool execution failed.',
      });
      expect(consoleError).toHaveBeenCalledWith(
        '[Fast Agent] Native tool bridge request failed.',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
      unbind();
    }
  });

  it('rejects unauthenticated and inactive-session calls', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-auth', []);
    const body = JSON.stringify({
      sessionID: 'missing-session',
      tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      args: { reason: 'duplicate' },
    });

    const unauthorized = await fetch(
      runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(unauthorized.status).toBe(401);

    const inactive = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body,
    });
    expect(inactive.status).toBe(409);
  });
});
