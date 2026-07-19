import fs from 'fs';
import os from 'os';
import path from 'path';

import { EnvService } from '../env';

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: () => ({
      succeed: vi.fn(),
      warn: vi.fn(),
      fail: vi.fn(),
    }),
  })),
}));

describe('EnvService.checkEnvVars', () => {
  let originalCwd: string;
  let tempRoot: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.R_MODEL;
    delete process.env.R_SMALL_MODEL;
    delete process.env.R_MODEL_ENV_KEYS;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.CUSTOM_PROVIDER_API_KEY;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-env-'));
    fs.mkdirSync(path.join(tempRoot, 'apps', 'dev'), { recursive: true });
    process.chdir(path.join(tempRoot, 'apps', 'dev'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates an empty local env file and allows setup to start without model config', async () => {
    process.env.R_PUBLIC_URL = 'https://roomote-example.ngrok.app';

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();

    expect(fs.readFileSync(path.join(tempRoot, '.env.local'), 'utf8')).toBe('');
  });

  it('requires a public URL from the local env file', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_MODEL=openrouter/openai/gpt-5.4',
        'OPENROUTER_API_KEY=openrouter-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).rejects.toThrow(
      'R_PUBLIC_URL is required',
    );
  });

  it('requires provider credentials for the configured model provider', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=openrouter/openai/gpt-5.4',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).rejects.toThrow(
      'Model provider credentials are required',
    );
  });

  it('requires provider/model format for the configured model', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=gpt-5.4',
        'OPENAI_API_KEY=openai-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).rejects.toThrow(
      'R_MODEL must use provider/model format',
    );
  });

  it('accepts bare LiteLLM route names when LITELLM_BASE_URL is set', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=qwen3.6-35b-local',
        'LITELLM_BASE_URL=http://localhost:4000',
        'LITELLM_API_KEY=litellm-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();
  });

  it('accepts required local values from the local env file', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=openrouter/openai/gpt-5.4',
        'OPENROUTER_API_KEY=openrouter-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();
  });

  it('accepts Vercel AI Gateway credentials from shared provider metadata', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=vercel/openai/gpt-5.4',
        'AI_GATEWAY_API_KEY=vercel-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();
  });

  it('accepts custom provider credentials from R_MODEL_ENV_KEYS', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env.local'),
      [
        'R_PUBLIC_URL=https://roomote-example.ngrok.app',
        'R_MODEL=custom-provider/custom-model',
        'R_MODEL_ENV_KEYS=CUSTOM_PROVIDER_API_KEY',
        'CUSTOM_PROVIDER_API_KEY=custom-key',
        '',
      ].join('\n'),
    );

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();
  });

  it('accepts model config from process env', async () => {
    process.env.R_MODEL = 'openrouter/openai/gpt-5.4';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.R_PUBLIC_URL = 'https://roomote-example.ngrok.app';

    await expect(EnvService.checkEnvVars()).resolves.toBeUndefined();
  });
});
