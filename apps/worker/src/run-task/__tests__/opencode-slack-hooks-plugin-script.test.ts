import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT } from '../opencode-slack-hooks-plugin-script';
import { SLACK_SILENCE_HOOK_SCRIPT } from '../slack-silence-hook-script';

interface ToolHookInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

interface ToolHookOutput {
  title: string;
  output: string;
  metadata: unknown;
}

type ToolHooks = {
  'tool.execute.before': (
    input: ToolHookInput,
    output: { args: unknown },
  ) => Promise<void>;
  'tool.execute.after': (
    input: ToolHookInput,
    output: ToolHookOutput,
  ) => Promise<void>;
};

describe('OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-slack-hooks-plugin-'),
    );
    delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    delete process.env.ROOMOTE_SLACK_CHANNEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadHooks(): Promise<ToolHooks> {
    const pluginDir = path.join(tempDir, 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginPath = path.join(pluginDir, 'roomote-slack-hooks.mjs');
    fs.writeFileSync(pluginPath, OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT, 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'roomote-opencode-slack-silence-hook.cjs'),
      SLACK_SILENCE_HOOK_SCRIPT,
      'utf8',
    );

    const module = (await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    )) as {
      RoomoteOpenCodeSlackHooks: () => Promise<ToolHooks>;
    };

    return await module.RoomoteOpenCodeSlackHooks();
  }

  it('appends the blocked reminder as a warning instead of failing the tool call', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now(),
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    const input: ToolHookInput = {
      tool: 'bash',
      sessionID: 'ses_parent',
      callID: 'call_1',
    };

    // The unacknowledged Slack turn used to make PreToolUse throw; it must
    // now resolve so the tool call still executes.
    await expect(
      hooks['tool.execute.before'](input, { args: {} }),
    ).resolves.toBeUndefined();

    const output: ToolHookOutput = {
      title: 'bash',
      output: 'tool output',
      metadata: {},
    };

    await hooks['tool.execute.after']({ ...input, args: {} }, output);

    expect(output.output.startsWith('tool output')).toBe(true);
    expect(output.output).toContain('chat-visible ack');
  });

  it('does not append a warning when the hook allows the tool call', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    const nowMs = Date.now();

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: nowMs,
        satisfiedTurnMessageTs: '111.222',
        messageTs: '111.333',
        tool: 'send_chat_reply',
        recordedAtMs: nowMs,
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    const input: ToolHookInput = {
      tool: 'bash',
      sessionID: 'ses_parent',
      callID: 'call_2',
    };

    await hooks['tool.execute.before'](input, { args: {} });

    const output: ToolHookOutput = {
      title: 'bash',
      output: 'tool output',
      metadata: {},
    };

    await hooks['tool.execute.after']({ ...input, args: {} }, output);

    expect(output.output).toBe('tool output');
  });

  it('rejects a progress reply before an automation task has a result', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: Date.now(),
        currentTurnRequiresInitialAck: false,
        requiresTerminalCloseoutWithoutTurn: true,
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    await expect(
      hooks['tool.execute.before'](
        {
          tool: 'roomote_send_chat_reply',
          sessionID: 'ses_parent',
          callID: 'call_automation_progress',
        },
        { args: { purpose: 'progress' } },
      ),
    ).rejects.toThrow('Automation-started tasks must stay silent');
  });

  it('allows a terminal automation reply when only the hook context has args', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: Date.now(),
        currentTurnRequiresInitialAck: false,
        requiresTerminalCloseoutWithoutTurn: true,
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    await expect(
      hooks['tool.execute.before'](
        {
          tool: 'roomote_send_chat_reply',
          sessionID: 'ses_parent',
          callID: 'call_automation_closeout',
        },
        { args: { purpose: 'closeout' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('fails Slack-posting tool calls from subagent sessions', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        parentThreadId: 'ses_parent',
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now(),
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    const input: ToolHookInput = {
      tool: 'roomote_send_chat_reply',
      sessionID: 'ses_subagent',
      callID: 'call_subagent_slack',
    };

    await expect(
      hooks['tool.execute.before'](input, { args: {} }),
    ).rejects.toThrow(
      'chat-posting tools are reserved for the parent agent session.',
    );
  });

  it('still allows non-Slack tool calls from subagent sessions', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        parentThreadId: 'ses_parent',
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now(),
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    const input: ToolHookInput = {
      tool: 'bash',
      sessionID: 'ses_subagent',
      callID: 'call_subagent_bash',
    };

    await expect(
      hooks['tool.execute.before'](input, { args: {} }),
    ).resolves.toBeUndefined();

    const output: ToolHookOutput = {
      title: 'bash',
      output: 'tool output',
      metadata: {},
    };

    await hooks['tool.execute.after']({ ...input, args: {} }, output);

    expect(output.output).toBe('tool output');
  });

  it('still applies the stashed PreToolUse warning when the PostToolUse evaluation fails', async () => {
    const stateFilePath = path.join(tempDir, 'slack-state.json');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now(),
      }),
      'utf8',
    );

    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = stateFilePath;
    process.env.ROOMOTE_NODE_EXECUTABLE = process.execPath;

    const hooks = await loadHooks();
    const input: ToolHookInput = {
      tool: 'bash',
      sessionID: 'ses_parent',
      callID: 'call_3',
    };

    await hooks['tool.execute.before'](input, { args: {} });

    // Break the silence hook script so the PostToolUse evaluation throws.
    fs.writeFileSync(
      path.join(tempDir, 'roomote-opencode-slack-silence-hook.cjs'),
      'process.exit(1);\n',
      'utf8',
    );

    const output: ToolHookOutput = {
      title: 'bash',
      output: 'tool output',
      metadata: {},
    };

    await expect(
      hooks['tool.execute.after']({ ...input, args: {} }, output),
    ).resolves.toBeUndefined();

    expect(output.output.startsWith('tool output')).toBe(true);
    expect(output.output).toContain('chat-visible ack');
  });
});
