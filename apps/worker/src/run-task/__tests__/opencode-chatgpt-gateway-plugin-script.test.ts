import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME } from '@roomote/types';

import { OPENCODE_CHATGPT_GATEWAY_PLUGIN_SCRIPT } from '../opencode-chatgpt-gateway-plugin-script';

interface OpenCodeModel {
  id: string;
  api: { id: string };
  options: Record<string, unknown>;
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  limit: { context: number; input?: number; output: number };
}

type ModelsHook = (provider: {
  models: Record<string, OpenCodeModel>;
}) => Promise<Record<string, OpenCodeModel>>;

describe('OPENCODE_CHATGPT_GATEWAY_PLUGIN_SCRIPT', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-chatgpt-gateway-plugin-'),
    );
    delete process.env[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME];
  });

  afterEach(() => {
    delete process.env[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadModelsHook(): Promise<ModelsHook> {
    const pluginPath = path.join(tempDir, 'roomote-chatgpt-gateway.mjs');
    fs.writeFileSync(
      pluginPath,
      OPENCODE_CHATGPT_GATEWAY_PLUGIN_SCRIPT,
      'utf8',
    );

    const module = (await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    )) as {
      RoomoteChatGptGatewayModels: () => Promise<{
        provider: { models: ModelsHook };
      }>;
    };
    const plugin = await module.RoomoteChatGptGatewayModels();

    return plugin.provider.models;
  }

  function createModel(
    id: string,
    options: Record<string, unknown> = {},
  ): OpenCodeModel {
    return {
      id,
      api: { id },
      options,
      cost: {
        input: 1.25,
        output: 10,
        cache: { read: 0.25, write: 1.25 },
      },
      limit: { context: 200_000, output: 64_000 },
    };
  }

  it('leaves ordinary OpenAI model metadata unchanged outside gateway mode', async () => {
    const models = {
      'gpt-5.4': createModel('gpt-5.4'),
      'gpt-4.1': createModel('gpt-4.1'),
    };
    const modelsHook = await loadModelsHook();

    await expect(modelsHook({ models })).resolves.toBe(models);
  });

  it('restores the subscription allowlist and zero-cost metadata in gateway mode', async () => {
    process.env[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME] = '1';
    const modelsHook = await loadModelsHook();
    const models = await modelsHook({
      models: {
        'gpt-5.4': createModel('gpt-5.4'),
        'gpt-5.6-luna': createModel('gpt-5.6-luna'),
        'gpt-5.6': createModel('gpt-5.6'),
        'gpt-5.5-pro': createModel('gpt-5.5-pro'),
        'gpt-5.7-pro': createModel('gpt-5.7-pro', {
          reasoningMode: 'pro',
        }),
        'gpt-4.1': createModel('gpt-4.1'),
      },
    });

    expect(Object.keys(models)).toEqual(['gpt-5.4', 'gpt-5.6-luna']);
    expect(models['gpt-5.4']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(models['gpt-5.6-luna']).toMatchObject({
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 500_000,
        input: 372_000,
        output: 128_000,
      },
    });
  });
});
