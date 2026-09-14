import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOpenCodeSubagentToolPolicyPluginScript } from '../opencode-subagent-tool-policy-plugin';

type Hooks = {
  'chat.headers': (input: {
    sessionID: string;
    agent: string;
  }) => Promise<void>;
  'tool.execute.before': (
    input: { sessionID: string; tool: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>;
};

async function loadHooks(): Promise<Hooks> {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'roomote-subagent-tool-policy-'),
  );
  const pluginPath = path.join(tempDir, 'judge-policy.mjs');
  try {
    fs.writeFileSync(
      pluginPath,
      createOpenCodeSubagentToolPolicyPluginScript({
        brokerNames: ['runtime-broker'],
        memoryNames: ['gbrain'],
        otherMcpNames: ['custom-tools'],
      }),
      'utf8',
    );
    const plugin = (await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    )) as { RoomoteOpenCodeSubagentToolPolicy: () => Promise<Hooks> };
    return await plugin.RoomoteOpenCodeSubagentToolPolicy();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('OpenCode subagent tool policy plugin', () => {
  it('allows evidence reads and blocks mounted mixed-tool mutations', async () => {
    const hooks = await loadHooks();
    await hooks['chat.headers']({ sessionID: 'judge-session', agent: 'judge' });

    await expect(
      hooks['tool.execute.before'](
        {
          sessionID: 'judge-session',
          tool: 'runtime-broker_integration_request',
        },
        { args: { method: 'GET' } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks['tool.execute.before'](
        {
          sessionID: 'judge-session',
          tool: 'runtime-broker_integration_request',
        },
        { args: { method: 'POST' } },
      ),
    ).rejects.toThrow('unavailable to this subagent capability policy');
    await expect(
      hooks['tool.execute.before'](
        {
          sessionID: 'judge-session',
          tool: 'runtime-broker_prepare_session_secret',
        },
        { args: {} },
      ),
    ).rejects.toThrow('unavailable to this subagent capability policy');
    await expect(
      hooks['tool.execute.before'](
        { sessionID: 'judge-session', tool: 'roomote_manage_tasks' },
        { args: { action: 'get_summary' } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks['tool.execute.before'](
        { sessionID: 'judge-session', tool: 'roomote_manage_tasks' },
        { args: { action: 'cancel' } },
      ),
    ).rejects.toThrow('unavailable to this subagent capability policy');
    await expect(
      hooks['tool.execute.before'](
        { sessionID: 'judge-session', tool: 'roomote_show_widget' },
        { args: {} },
      ),
    ).rejects.toThrow('unavailable to this subagent capability policy');
    await expect(
      hooks['tool.execute.before'](
        { sessionID: 'judge-session', tool: 'custom-tools_publish' },
        { args: {} },
      ),
    ).rejects.toThrow('unavailable to this subagent capability policy');
  });

  it('injects trusted caller identity and leaves advisor behavior unchanged', async () => {
    const hooks = await loadHooks();
    await hooks['chat.headers']({ sessionID: 'judge-session', agent: 'judge' });
    await hooks['chat.headers']({
      sessionID: 'advisor-session',
      agent: 'advisor',
    });
    const judgeOutput = {
      args: { _callerToolPolicy: 'unrestricted' } as Record<string, unknown>,
    };
    const advisorOutput = { args: {} as Record<string, unknown> };
    const unknownOutput = { args: {} as Record<string, unknown> };

    await hooks['tool.execute.before'](
      { sessionID: 'judge-session', tool: 'roomote_find_integration_tools' },
      judgeOutput,
    );
    await expect(
      hooks['tool.execute.before'](
        {
          sessionID: 'advisor-session',
          tool: 'runtime-broker_prepare_session_secret',
        },
        advisorOutput,
      ),
    ).resolves.toBeUndefined();
    await hooks['tool.execute.before'](
      { sessionID: 'unknown-session', tool: 'roomote_call_integration_tool' },
      unknownOutput,
    );

    expect(judgeOutput.args._callerToolPolicy).toBe('evidence_review');
    expect(advisorOutput.args).toEqual({});
    expect(unknownOutput.args._callerToolPolicy).toBe('unknown');
  });
});
