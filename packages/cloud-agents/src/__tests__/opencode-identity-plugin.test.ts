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

  it.each(['OpenCode', 'opencode'])(
    'removes only the leading %s identity declaration',
    async (productName) => {
      const transform = await loadSystemTransformHook();
      const output = {
        system: [
          `You are ${productName}, You and the user share the same workspace.\n\n## Editing Approach`,
          'You are Roomote in fast mode.',
        ],
      };

      await transform({}, output);

      expect(output.system).toEqual([
        'You and the user share the same workspace.\n\n## Editing Approach',
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
