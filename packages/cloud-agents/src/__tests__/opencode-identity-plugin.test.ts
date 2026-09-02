import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_IDENTITY_PLUGIN_SCRIPT } from '../opencode-identity-plugin';

type SystemTransformHook = (
  input: unknown,
  output: { system: string[] },
) => Promise<void>;

describe('OPENCODE_IDENTITY_PLUGIN_SCRIPT', () => {
  async function loadSystemTransformHook(): Promise<SystemTransformHook> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-identity-plugin-'),
    );
    const pluginPath = path.join(tempDir, 'roomote-identity.mjs');

    try {
      fs.writeFileSync(pluginPath, OPENCODE_IDENTITY_PLUGIN_SCRIPT, 'utf8');
      const plugin = (await import(
        /* @vite-ignore */ pathToFileURL(pluginPath).href
      )) as {
        RoomoteOpenCodeIdentity: () => Promise<{
          'experimental.chat.system.transform': SystemTransformHook;
        }>;
      };
      const hooks = await plugin.RoomoteOpenCodeIdentity();
      return hooks['experimental.chat.system.transform'];
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
});
