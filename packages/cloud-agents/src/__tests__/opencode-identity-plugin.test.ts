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

  function withBridgeEnv(
    values: Record<string, string | undefined>,
    run: () => Promise<void>,
  ): Promise<void> {
    const originals = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run().finally(() => {
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  const bridgeEnv = {
    ROOMOTE_FAST_TOOL_BRIDGE_AUTHORIZE_URL: 'http://127.0.0.1:1234/authorize',
    ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'secret',
  };

  it.each(['task', 'send_chat_reply', 'roomote_search_code', 'list_skills'])(
    'asks the bridge to authorize every tool call before it runs (%s)',
    (tool) =>
      withBridgeEnv(bridgeEnv, async () => {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true, allowed: true }),
        });
        vi.stubGlobal('fetch', fetchMock);
        const hook = (await loadHooks())['tool.execute.before'];

        await expect(
          hook({ tool, sessionID: 'fast-parent-session' }),
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith(
          'http://127.0.0.1:1234/authorize',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              authorization: 'Bearer secret',
            }),
            body: JSON.stringify({ sessionID: 'fast-parent-session', tool }),
          }),
        );
      }),
  );

  it('rejects the tool call with the bridge denial message', () =>
    withBridgeEnv(bridgeEnv, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            ok: true,
            allowed: false,
            error:
              'Post an acknowledgement with send_chat_reply before this action.',
          }),
        }),
      );
      const hook = (await loadHooks())['tool.execute.before'];

      await expect(
        hook({ tool: 'task', sessionID: 'fast-parent-session' }),
      ).rejects.toThrow(
        'Post an acknowledgement with send_chat_reply before this action.',
      );
    }));

  it.each([
    {
      name: 'a non-2xx bridge response',
      response: {
        ok: false,
        json: vi.fn().mockResolvedValue({ ok: false, error: 'unauthorized' }),
      },
      message: 'unauthorized',
    },
    {
      name: 'a non-JSON bridge response',
      response: {
        ok: true,
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
      },
      message: 'Roomote Fast tool authorization failed.',
    },
  ])('fails closed on $name', ({ response, message }) =>
    withBridgeEnv(bridgeEnv, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const hook = (await loadHooks())['tool.execute.before'];

      await expect(
        hook({ tool: 'task', sessionID: 'fast-parent-session' }),
      ).rejects.toThrow(message);
    }),
  );

  it('does nothing outside a Fast tool bridge runtime', () =>
    withBridgeEnv(
      { ROOMOTE_FAST_TOOL_BRIDGE_AUTHORIZE_URL: undefined },
      async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const hook = (await loadHooks())['tool.execute.before'];

        await expect(
          hook({ tool: 'task', sessionID: 'standard-session' }),
        ).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    ));
});
