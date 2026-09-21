import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_IDENTITY_PLUGIN_SCRIPT } from '../opencode-identity-plugin';

type SystemTransformHook = (
  input: unknown,
  output: { system: string[] },
) => Promise<void>;

type MessageTransformHook = (
  input: unknown,
  output: {
    messages: Array<{
      info: { role: string; providerID?: string; modelID?: string };
      parts: Array<Record<string, unknown>>;
    }>;
  },
) => Promise<void>;

describe('OPENCODE_IDENTITY_PLUGIN_SCRIPT', () => {
  async function loadSystemTransformHook(): Promise<SystemTransformHook> {
    const hooks = await loadHooks();
    return hooks['experimental.chat.system.transform'];
  }

  async function loadHooks(): Promise<{
    'experimental.chat.system.transform': SystemTransformHook;
    'experimental.chat.messages.transform': MessageTransformHook;
  }> {
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
          'experimental.chat.messages.transform': MessageTransformHook;
        }>;
      };
      return await plugin.RoomoteOpenCodeIdentity();
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
    {
      name: 'GPT-6 prompt',
      prompt:
        'You are an AI agent powered by OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness',
      expected:
        'Help the user accomplish their goals using the tools you have available.\n\n# Harness',
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

  it('preserves and consolidates OpenRouter Gemini reasoning details for tool-call replay', async () => {
    const hooks = await loadHooks();
    const encrypted = {
      type: 'reasoning.encrypted',
      data: 'opaque-provider-data',
      id: 'tool_read_1',
      format: 'google-gemini-v1',
      index: 0,
    };
    const text = {
      type: 'reasoning.text',
      text: 'summary',
      format: 'google-gemini-v1',
      index: 0,
    };
    const output = {
      messages: [
        {
          info: {
            role: 'assistant',
            providerID: 'openrouter',
            modelID: 'google/gemini-3.8-flash',
          },
          parts: [
            {
              type: 'reasoning',
              text: 'summary',
              metadata: { openrouter: { reasoning_details: [text] } },
            },
            {
              type: 'tool',
              callID: 'tool_read_1',
              metadata: {
                openrouter: { reasoning_details: [text, encrypted] },
              },
            },
          ],
        },
      ],
    };

    await hooks['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0]?.parts[0]?.metadata).toEqual({
      openrouter: { reasoning_details: [text, encrypted] },
    });
    expect(output.messages[0]?.parts[1]?.metadata).toEqual({
      openrouter: { reasoning_details: [text, encrypted] },
    });
  });

  it('adds the Gemini validator bypass only when encrypted reasoning is unavailable', async () => {
    const hooks = await loadHooks();
    const output = {
      messages: [
        {
          info: {
            role: 'assistant',
            providerID: 'openrouter',
            modelID: 'google/gemini-3.8-flash',
          },
          parts: [
            {
              type: 'tool',
              callID: 'tool_read_1',
              metadata: { existing: 'metadata' },
            },
          ],
        },
      ],
    };

    const transform = hooks['experimental.chat.messages.transform'];
    await transform({}, output);
    await transform({}, output);

    expect(output.messages[0]?.parts[0]?.metadata).toEqual({
      existing: 'metadata',
      openrouter: {
        reasoning_details: [
          {
            type: 'reasoning.encrypted',
            data: 'skip_thought_signature_validator',
            id: 'tool_read_1',
            format: 'google-gemini-v1',
            index: 0,
          },
        ],
      },
    });
  });

  it('leaves non-OpenRouter and pre-Gemini-3 histories unchanged', async () => {
    const hooks = await loadHooks();
    const output = {
      messages: [
        {
          info: {
            role: 'assistant',
            providerID: 'google',
            modelID: 'gemini-3.8-flash',
          },
          parts: [{ type: 'tool', callID: 'google-tool' }],
        },
        {
          info: {
            role: 'assistant',
            providerID: 'openrouter',
            modelID: 'google/gemini-2.5-pro',
          },
          parts: [{ type: 'tool', callID: 'old-gemini-tool' }],
        },
      ],
    };
    const original = structuredClone(output);

    await hooks['experimental.chat.messages.transform']({}, output);

    expect(output).toEqual(original);
  });
});
