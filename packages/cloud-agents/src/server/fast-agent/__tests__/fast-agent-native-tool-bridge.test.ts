import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bindFastAgentNativeToolExecutor,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_NAMES,
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
    expect(integrationSource).toContain('export default {');
    expect(integrationSource).toContain('invoke("integration_call"');
    expect(bridgeSource).toContain('context.sessionID');
    expect(bridgeSource).toContain('metadata: { roomoteResult:');
    expect(FAST_AGENT_NATIVE_TOOL_FILTER).toMatchObject({
      '*': false,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: true,
    });
  });

  it('routes raw JSON arguments and results by OpenCode session id', async () => {
    const runtime = await getFastAgentNativeToolRuntime();
    const executor = vi.fn(async ({ name, args }) => ({
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
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
          args: {
            integrationId: 'github',
            toolName: 'search_code',
            arguments: { query: 'Fast', nested: { exact: true } },
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          name: FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall,
          echoed: {
            integrationId: 'github',
            toolName: 'search_code',
            arguments: { query: 'Fast', nested: { exact: true } },
          },
          nestedResult: { values: [1, 2, 3] },
        },
      });
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
