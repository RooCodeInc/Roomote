import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_IDENTITY_PLUGIN_SCRIPT } from '../opencode-identity-plugin';

type SystemTransformHook = (
  input: unknown,
  output: { system: string[] },
) => Promise<void>;

type ToolExecuteBeforeHook = (input: {
  tool: string;
  sessionID: string;
}) => Promise<void>;

type IdentityPluginHooks = {
  'experimental.chat.system.transform': SystemTransformHook;
  'tool.execute.before': ToolExecuteBeforeHook;
};

describe('OPENCODE_IDENTITY_PLUGIN_SCRIPT', () => {
  async function loadHooks(): Promise<IdentityPluginHooks> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-identity-plugin-'),
    );
    const pluginPath = path.join(tempDir, 'roomote-identity.mjs');

    try {
      fs.writeFileSync(pluginPath, OPENCODE_IDENTITY_PLUGIN_SCRIPT, 'utf8');
      const plugin = (await import(
        /* @vite-ignore */ pathToFileURL(pluginPath).href
      )) as {
        RoomoteOpenCodeIdentity: () => Promise<IdentityPluginHooks>;
      };
      return await plugin.RoomoteOpenCodeIdentity();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function loadSystemTransformHook(): Promise<SystemTransformHook> {
    return (await loadHooks())['experimental.chat.system.transform'];
  }

  it.each([
    {
      name: 'default prompt',
      prompt:
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.',
      expected:
        'an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.',
    },
    {
      name: 'Anthropic prompt',
      prompt:
        'You are OpenCode, the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks.',
      expected:
        'the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks.',
    },
    {
      name: 'GPT prompt',
      prompt:
        "You are OpenCode, You and the user share the same workspace and collaborate to achieve the user's goals.",
      expected:
        "You and the user share the same workspace and collaborate to achieve the user's goals.",
    },
  ])(
    'removes only the leading identity declaration from the $name',
    async ({ prompt, expected }) => {
      const transform = await loadSystemTransformHook();
      const output = {
        system: [prompt, 'You are Roomote in fast mode.'],
      };

      await transform({}, output);

      expect(output.system).toEqual([
        expected,
        'You are Roomote in fast mode.',
      ]);
    },
  );

  it('does not rewrite non-leading or Roomote identity text', async () => {
    const transform = await loadSystemTransformHook();
    const output = {
      system: [
        'Preserve this preface. You are OpenCode, as referenced in documentation.',
        'You are Roomote, a software engineering teammate.',
      ],
    };
    const original = structuredClone(output.system);

    await transform({}, output);

    expect(output.system).toEqual(original);
  });

  it('requires Fast task subagents to pass bridge authorization before execution', async () => {
    const originalUrl = process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL;
    const originalToken = process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN;
    process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL = 'http://127.0.0.1:1234/tool';
    process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        allowed: false,
        error:
          'Post an acknowledgement with send_chat_reply before this action.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const hook = (await loadHooks())['tool.execute.before'];

      await expect(
        hook({ tool: 'task', sessionID: 'fast-parent-session' }),
      ).rejects.toThrow(
        'Post an acknowledgement with send_chat_reply before this action.',
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/authorize-substantive-tool',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sessionID: 'fast-parent-session',
            tool: 'task',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      if (originalUrl === undefined) {
        delete process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL;
      } else {
        process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL = originalUrl;
      }
      if (originalToken === undefined) {
        delete process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN;
      } else {
        process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN = originalToken;
      }
    }
  });

  it('does not authorize non-task tools or non-Fast task sessions', async () => {
    const originalUrl = process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL;
    delete process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const hook = (await loadHooks())['tool.execute.before'];
      await expect(
        hook({ tool: 'task', sessionID: 'standard-session' }),
      ).resolves.toBeUndefined();

      process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL = 'http://127.0.0.1:1234/tool';
      await expect(
        hook({ tool: 'read', sessionID: 'fast-parent-session' }),
      ).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (originalUrl === undefined) {
        delete process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL;
      } else {
        process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL = originalUrl;
      }
    }
  });
});
