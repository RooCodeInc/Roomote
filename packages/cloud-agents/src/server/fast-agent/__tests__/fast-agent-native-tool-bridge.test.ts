import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALL_REPOSITORIES } from '@roomote/types';

import {
  bindFastAgentMcpToolExecutor,
  bindFastAgentNativeToolExecutor,
  createFastAgentSpillTurnBudget,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_SPILL_TURN_CALL_LIMIT,
  FAST_AGENT_SPILL_TURN_OUTPUT_LIMIT_BYTES,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
  getFastAgentNativeToolRuntime,
} from '../fast-agent-native-tool-bridge';
import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from '../fast-agent-spill-store';
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
    const spillReadSource = await readFile(
      join(toolsDirectory, 'spill_read.js'),
      'utf8',
    );

    expect(installedToolFiles.sort()).toEqual(
      Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)
        .map((name) => `${name}.js`)
        .sort(),
    );
    expect(replySource).toContain('export default {');
    expect(replySource).toContain('invoke("send_chat_reply"');
    expect(launchTaskSource).toContain('model: z.string().min(1)');
    expect(launchTaskSource).toContain('deployment-enabled model ID');
    expect(launchTaskSource).toContain(
      'Brief user-facing description of the work now underway',
    );
    expect(launchTaskSource).toContain(
      'do not mention delegation, launching, or queue state',
    );
    expect(launchTaskSource).not.toContain(
      'explanation of what is being delegated',
    );
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
    expect(bridgeSource).toContain('metadata: payload.metadata ?? {}');
    expect(spillReadSource).toContain('never pass filesystem paths');
    expect(FAST_AGENT_NATIVE_TOOL_FILTER).toMatchObject({
      '*': false,
      task: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead]: true,
    });
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER).toMatchObject({
      '*': true,
      task: false,
      roomote_manage_custom_automations: false,
    });
    for (const rawFilesystemTool of [
      'read',
      'glob',
      'grep',
      'bash',
      'write',
      'edit',
    ]) {
      expect(FAST_AGENT_NATIVE_TOOL_FILTER[rawFilesystemTool]).not.toBe(true);
    }
    for (const parentOnlyTool of [
      FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      FAST_AGENT_NATIVE_TOOL_NAMES.launchTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage,
      FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
      FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
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

  it('spills oversized MCP results for direct parent recovery', async () => {
    const conversationId = 'mcp-spill-conversation';
    const parentSessionId = 'mcp-spill-parent-session';
    const runtime = await getFastAgentNativeToolRuntime(conversationId, [
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const unbindMcp = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      async () => ({ text: 'MCP evidence '.repeat(6_000) }),
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSessionId,
      conversationId,
      async () => null,
      { allowSpillRecovery: true },
    );

    try {
      const descriptor = (await callMcpTool({
        url: config.mcp.github!.url,
        headers: config.mcp.github!.headers,
        toolName: 'search_code',
        args: {},
      })) as {
        preview: string;
        spill: { byteLength: number; guidance: string; handle: string };
        truncated: boolean;
      };
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { handle: expect.any(String), byteLength: expect.any(Number) },
      });
      expect(descriptor.spill.guidance).toContain(
        'subagent should return the handle verbatim',
      );
      expect(
        Buffer.byteLength(JSON.stringify(descriptor), 'utf8'),
      ).toBeLessThanOrEqual(FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES);

      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: parentSessionId,
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
          args: { handle: descriptor.spill.handle, query: 'MCP evidence' },
        }),
      }).then((result) => result.json());
      expect(JSON.parse(response.output)).toMatchObject({
        success: true,
        result: { matches: expect.any(Array) },
      });
    } finally {
      unbindParent();
      unbindMcp();
    }
  });

  it('finds the first match near the end of a maximum-size MCP result', async () => {
    const conversationId = 'mcp-max-result-conversation';
    const parentSessionId = 'mcp-max-result-parent';
    const marker = 'FIRST_MATCH_NEAR_EOF';
    const result = `${'x'.repeat(
      FAST_AGENT_SPILL_MAX_FILE_BYTES - marker.length - 2,
    )}${marker}`;
    const runtime = await getFastAgentNativeToolRuntime(conversationId, [
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const budget = createFastAgentSpillTurnBudget();
    const unbindMcp = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      async () => result,
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSessionId,
      conversationId,
      async () => null,
      { allowSpillRecovery: true, spillBudget: budget },
    );

    try {
      const descriptor = (await callMcpTool({
        url: config.mcp.github!.url,
        headers: config.mcp.github!.headers,
        toolName: 'search_code',
        args: {},
      })) as { spill: { byteLength: number; handle: string } };
      expect(descriptor.spill.byteLength).toBe(FAST_AGENT_SPILL_MAX_FILE_BYTES);
      expect(budget.calls).toBe(0);

      let offset = 0;
      let matchOffset: number | undefined;
      while (
        offset < descriptor.spill.byteLength &&
        matchOffset === undefined
      ) {
        const response = await fetch(
          runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              sessionID: parentSessionId,
              tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
              args: { handle: descriptor.spill.handle, query: marker, offset },
            }),
          },
        ).then((value) => value.json());
        const search = JSON.parse(response.output);
        expect(search.success).toBe(true);
        matchOffset = search.result.matches[0]?.offset;
        offset = search.result.nextOffset ?? descriptor.spill.byteLength;
      }

      expect(matchOffset).toBe(
        FAST_AGENT_SPILL_MAX_FILE_BYTES - marker.length - 1,
      );
      expect(budget.calls).toBe(4);
    } finally {
      unbindParent();
      unbindMcp();
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
      'conversation-1',
      executor,
      { allowSpillRecovery: true },
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
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: true,
        metadata: {
          roomoteResult: {
            agent: 'judge',
            name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          },
        },
      });
      expect(JSON.parse(payload.output)).toEqual({
        agent: 'judge',
        name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        echoed: { reason: 'test' },
        nestedResult: { values: [1, 2, 3] },
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
      'conversation-sensitive-error',
      async () => {
        throw new Error('database password appeared in a downstream stack');
      },
      { allowSpillRecovery: true },
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

  it('spills oversized output before OpenCode can invoke its native spill writer', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-spill', []);
    const parentSession = 'opencode-parent-spill';
    const childSession = 'opencode-child-spill';
    const otherSession = 'opencode-other-spill';
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSession,
      'conversation-spill',
      async () => ({ text: '😀'.repeat(20_000) }),
      { allowSpillRecovery: true },
    );
    const unbindChild = bindFastAgentNativeToolExecutor(
      childSession,
      'conversation-spill',
      async () => null,
      { allowSpillRecovery: false },
    );
    const unbindOther = bindFastAgentNativeToolExecutor(
      otherSession,
      'other-conversation',
      async () => null,
      { allowSpillRecovery: true },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        args: {},
      });
      expect(Buffer.byteLength(oversized.output, 'utf8')).toBeLessThanOrEqual(
        FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES,
      );
      expect(oversized.output.split('\n')).toHaveLength(1);
      expect(oversized.metadata).toMatchObject({ truncated: true });
      const descriptor = JSON.parse(oversized.output);
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { byteLength: expect.any(Number), handle: expect.any(String) },
      });
      expect(descriptor.preview).not.toContain('�');

      const parentRead = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle: descriptor.spill.handle, limit: 64 },
      });
      expect(Buffer.byteLength(parentRead.output, 'utf8')).toBeLessThanOrEqual(
        FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES,
      );
      expect(JSON.parse(parentRead.output)).toMatchObject({
        success: true,
        result: { handle: descriptor.spill.handle },
      });

      const crossSessionRead = await callBridge({
        sessionID: otherSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle: descriptor.spill.handle },
      });
      expect(JSON.parse(crossSessionRead.output)).toEqual({
        success: false,
        error:
          'The result handle is unavailable for this conversation or has expired.',
      });
    } finally {
      unbindOther();
      unbindChild();
      unbindParent();
    }
  });

  it('denies spill recovery to every child agent capability', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-advisor', []);
    const budget = createFastAgentSpillTurnBudget();
    const unbindAdvisor = bindFastAgentNativeToolExecutor(
      'advisor-session',
      'shared-conversation',
      async () => ({ text: 'advisor evidence '.repeat(5_000) }),
      { allowSpillRecovery: false, spillBudget: budget },
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      'parent-session',
      'shared-conversation',
      async () => null,
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge({
        sessionID: 'advisor-session',
        agent: 'advisor',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        args: {},
      });
      const descriptor = JSON.parse(oversized.output);
      expect(descriptor.spill.guidance).toContain(
        'subagent should return the handle verbatim',
      );

      for (const agent of ['general', 'explore', 'advisor', 'judge']) {
        const childRead = await callBridge({
          sessionID: 'advisor-session',
          agent,
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
          args: { handle: descriptor.spill.handle },
        });
        expect(JSON.parse(childRead.output)).toEqual({
          success: false,
          error:
            'Result recovery tools are reserved for the Fast parent agent.',
        });
      }

      const parentSearch = await callBridge({
        sessionID: 'parent-session',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
        args: { handle: descriptor.spill.handle, query: 'advisor evidence' },
      });
      const searchResult = JSON.parse(parentSearch.output);
      expect(searchResult).toMatchObject({ success: true });
      expect(searchResult.result.matches[0]).toEqual(
        expect.objectContaining({ offset: expect.any(Number) }),
      );
    } finally {
      unbindParent();
      unbindAdvisor();
    }
  });

  it('enforces the cumulative per-turn spill call limit', async () => {
    const runtime = await getFastAgentNativeToolRuntime(
      'native-call-budget',
      [],
    );
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-call-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-call-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (tool: string, args: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID, tool, args }),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge(
        FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        {},
      );
      const handle = JSON.parse(oversized.output).spill.handle;
      for (
        let index = 0;
        index < FAST_AGENT_SPILL_TURN_CALL_LIMIT;
        index += 1
      ) {
        const read = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
          handle,
          limit: 1,
          offset: index,
        });
        expect(JSON.parse(read.output)).toMatchObject({ success: true });
      }
      const blocked = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
        handle,
        limit: 1,
      });
      expect(JSON.parse(blocked.output)).toEqual({
        success: false,
        error: 'The per-turn result recovery call limit has been reached.',
      });
    } finally {
      unbind();
    }
  });

  it('enforces the cumulative per-turn spill output budget', async () => {
    const runtime = await getFastAgentNativeToolRuntime(
      'native-output-budget',
      [],
    );
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-output-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-output-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (tool: string, args: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID, tool, args }),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge(
        FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        {},
      );
      const handle = JSON.parse(oversized.output).spill.handle;
      let blocked: { output: string } | undefined;
      for (
        let index = 0;
        index < FAST_AGENT_SPILL_TURN_CALL_LIMIT;
        index += 1
      ) {
        const read = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
          handle,
          limit: 5_000,
          offset: index * 5_000,
        });
        if (!JSON.parse(read.output).success) {
          blocked = read;
          break;
        }
      }
      expect(blocked).toBeDefined();
      expect(JSON.parse(blocked!.output)).toEqual({
        success: false,
        error: 'The per-turn result recovery output budget has been reached.',
      });
      expect(budget.outputBytes).toBeLessThanOrEqual(
        FAST_AGENT_SPILL_TURN_OUTPUT_LIMIT_BYTES,
      );
    } finally {
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
