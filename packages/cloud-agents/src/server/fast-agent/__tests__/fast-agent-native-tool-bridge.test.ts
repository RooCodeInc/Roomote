import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOMOTE_TASK_INSPECTION_ACTIONS } from '@roomote/types';

import {
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

describe('Fast native OpenCode tool bridge', () => {
  it('installs Fast tools in an isolated OpenCode session directory', async () => {
    const runtime = await getFastAgentNativeToolRuntime();
    const toolsDirectory = join(runtime.directory, '.opencode', 'tools');
    const installedToolFiles = await readdir(toolsDirectory);
    const replySource = await readFile(
      join(toolsDirectory, 'send_chat_reply.js'),
      'utf8',
    );
    const integrationSource = await readFile(
      join(toolsDirectory, 'integration_call.js'),
      'utf8',
    );
    const launchTaskSource = await readFile(
      join(toolsDirectory, 'launch_task.js'),
      'utf8',
    );
    const manageTasksSource = await readFile(
      join(toolsDirectory, 'manage_tasks.js'),
      'utf8',
    );
    const messageContextSource = await readFile(
      join(toolsDirectory, 'get_chat_message_context.js'),
      'utf8',
    );
    const channelMessagesSource = await readFile(
      join(toolsDirectory, 'get_chat_channel_messages.js'),
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
    expect(integrationSource).toContain('export default {');
    expect(integrationSource).toContain('invoke("integration_call"');
    expect(launchTaskSource).toContain('model: z.string().min(1)');
    expect(launchTaskSource).toContain('deployment-enabled model ID');
    expect(manageTasksSource).toContain('invoke("manage_tasks"');
    expect(manageTasksSource).toContain(
      `z.enum(${JSON.stringify(ROOMOTE_TASK_INSPECTION_ACTIONS)})`,
    );
    expect(manageTasksSource).toContain(
      'Use launch_task, send_task_message, or cancel_task for task changes',
    );
    expect(messageContextSource).toContain('invoke("get_chat_message_context"');
    expect(messageContextSource).toContain('messageId: z.string().min(1)');
    expect(messageContextSource).not.toContain('channel:');
    expect(channelMessagesSource).toContain(
      'invoke("get_chat_channel_messages"',
    );
    expect(channelMessagesSource).toContain(
      'defaults Slack history to the previous 24 hours',
    );
    expect(channelMessagesSource).not.toContain('channel:');
    expect(bridgeSource).toContain('context.sessionID');
    expect(bridgeSource).toContain('agent: context.agent');
    expect(bridgeSource).toContain('metadata: payload.metadata ?? {}');
    expect(spillReadSource).toContain('never pass filesystem paths');
    expect(FAST_AGENT_NATIVE_TOOL_FILTER).toMatchObject({
      '*': false,
      task: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.getChatMessageContext]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.getChatChannelMessages]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead]: true,
    });
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER).toEqual({
      '*': false,
      [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks]: true,
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
      FAST_AGENT_NATIVE_TOOL_NAMES.getChatMessageContext,
      FAST_AGENT_NATIVE_TOOL_NAMES.getChatChannelMessages,
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

  it('routes raw JSON arguments and results by OpenCode session id', async () => {
    const runtime = await getFastAgentNativeToolRuntime();
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
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
          args: {
            integrationId: 'github',
            toolName: 'search_code',
            arguments: { query: 'Fast', nested: { exact: true } },
          },
        }),
      });

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: true,
        metadata: {
          roomoteResult: {
            agent: 'judge',
            name: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
          },
        },
      });
      expect(JSON.parse(payload.output)).toEqual({
        agent: 'judge',
        name: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
        echoed: {
          integrationId: 'github',
          toolName: 'search_code',
          arguments: { query: 'Fast', nested: { exact: true } },
        },
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
    const runtime = await getFastAgentNativeToolRuntime();
    const unbind = bindFastAgentNativeToolExecutor(
      'opencode-session-sensitive-error',
      'conversation-sensitive-error',
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
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
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
    const runtime = await getFastAgentNativeToolRuntime();
    const parentSession = 'opencode-parent-spill';
    const childSession = 'opencode-child-spill';
    const otherSession = 'opencode-other-spill';
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSession,
      'conversation-spill',
      async () => ({ text: '😀'.repeat(20_000) }),
    );
    const unbindChild = bindFastAgentNativeToolExecutor(
      childSession,
      'conversation-spill',
      async () => null,
    );
    const unbindOther = bindFastAgentNativeToolExecutor(
      otherSession,
      'other-conversation',
      async () => null,
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
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
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

  it('returns advisor handles to the Fast parent without delegation guidance', async () => {
    const runtime = await getFastAgentNativeToolRuntime();
    const budget = createFastAgentSpillTurnBudget();
    const unbindAdvisor = bindFastAgentNativeToolExecutor(
      'advisor-session',
      'shared-conversation',
      async () => ({ text: 'advisor evidence '.repeat(5_000) }),
      budget,
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      'parent-session',
      'shared-conversation',
      async () => null,
      budget,
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
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
        args: {},
      });
      const descriptor = JSON.parse(oversized.output);
      expect(descriptor.spill.guidance).toContain(
        'Return this handle verbatim',
      );
      expect(descriptor.spill.guidance).not.toContain('delegate');

      const advisorRead = await callBridge({
        sessionID: 'advisor-session',
        agent: 'advisor',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle: descriptor.spill.handle },
      });
      expect(JSON.parse(advisorRead.output)).toEqual({
        success: false,
        error: 'Result recovery tools are reserved for the Fast parent agent.',
      });

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
    const runtime = await getFastAgentNativeToolRuntime();
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-call-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-call-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      budget,
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
        FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
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
    const runtime = await getFastAgentNativeToolRuntime();
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-output-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-output-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      budget,
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
        FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
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
    const runtime = await getFastAgentNativeToolRuntime();
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
