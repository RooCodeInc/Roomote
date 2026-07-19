import path from 'path';
import fs from 'fs';

import ora from 'ora';
import {
  applyImplicitLiteLlmModelPrefix,
  getModelProviderEnvKeyCandidates,
  resolveModelProviderIdFromModel,
} from '@roomote/types';

function readEnvFileValues(envLocalPath: string): Record<string, string> {
  if (!fs.existsSync(envLocalPath)) {
    return {};
  }

  const values: Record<string, string> = {};
  const content = fs.readFileSync(envLocalPath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    values[trimmed.slice(0, separatorIndex).trim()] = trimmed
      .slice(separatorIndex + 1)
      .trim();
  }

  return values;
}

function isConfiguredEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().replace(/^['"]|['"]$/g, '') !== '';
}

function getConfiguredEnvValue(
  key: string,
  fileValues: Record<string, string>,
): string | undefined {
  return process.env[key] ?? fileValues[key];
}

function getModelProviderKeyCandidates({
  provider,
  fileValues,
}: {
  provider: string;
  fileValues: Record<string, string>;
}): string[] {
  const configuredKeyList = getConfiguredEnvValue(
    'R_MODEL_ENV_KEYS',
    fileValues,
  );

  return getModelProviderEnvKeyCandidates({
    providerId: provider,
    configuredEnvKeys: configuredKeyList,
  });
}

export class EnvService {
  static async checkEnvVars(): Promise<void> {
    const checkEnvVars = ora('Checking .env.local').start();

    const envLocalPath = path.resolve(process.cwd(), '../..', '.env.local');

    if (!fs.existsSync(envLocalPath)) {
      fs.writeFileSync(envLocalPath, '');
    }

    const fileValues = readEnvFileValues(envLocalPath);
    const publicUrl = process.env.R_PUBLIC_URL ?? fileValues.R_PUBLIC_URL;
    const model = getConfiguredEnvValue('R_MODEL', fileValues)?.trim();

    if (isConfiguredEnvValue(model)) {
      const resolvedModel = applyImplicitLiteLlmModelPrefix(
        model,
        isConfiguredEnvValue(
          getConfiguredEnvValue('LITELLM_BASE_URL', fileValues),
        ),
      );
      const provider =
        resolveModelProviderIdFromModel(resolvedModel)?.toLowerCase();

      if (!provider) {
        checkEnvVars.fail();
        throw new Error(
          'R_MODEL must use provider/model format.\n' +
            '\n' +
            'Example:\n' +
            '\n' +
            'R_MODEL=openrouter/anthropic/claude-sonnet-4\n' +
            '\n' +
            'When LITELLM_BASE_URL is set, bare LiteLLM route names are also accepted.\n',
        );
      }

      const modelProviderKeyCandidates = getModelProviderKeyCandidates({
        provider,
        fileValues,
      });
      const hasModelProviderKey = modelProviderKeyCandidates.some((key) =>
        isConfiguredEnvValue(getConfiguredEnvValue(key, fileValues)),
      );

      if (!hasModelProviderKey) {
        const suggestedKeys =
          modelProviderKeyCandidates.length > 0
            ? modelProviderKeyCandidates.join(', ')
            : 'R_MODEL_ENV_KEYS=<provider-key-env-name>';

        checkEnvVars.fail();
        throw new Error(
          'Model provider credentials are required for local Roomote tasks.\n' +
            '\n' +
            `R_MODEL uses provider "${provider}". Add one of these values to .env.local:\n` +
            '\n' +
            `${suggestedKeys}\n` +
            '\n' +
            'If your provider uses a different env var name, set R_MODEL_ENV_KEYS to that name.',
        );
      }
    }

    if (!isConfiguredEnvValue(publicUrl)) {
      checkEnvVars.fail();
      throw new Error(
        'R_PUBLIC_URL is required for local Roomote callbacks.\n' +
          '\n' +
          'Set it to any public HTTPS URL that reaches port 13000 (an ngrok\n' +
          'domain, Cloudflare Tunnel, Tailscale Funnel, or your own domain). For\n' +
          'an ngrok domain, pnpm dev starts and reuses the tunnel for you:\n' +
          '\n' +
          'R_PUBLIC_URL=https://your-ngrok-domain.ngrok.app\n',
      );
    }

    checkEnvVars.succeed();
  }
}
