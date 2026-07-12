import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateOpenCodeConfig } from './agent-home';

describe('generateOpenCodeConfig provider support', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createHomeDir(): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'roomote-opencode-'));
    tempDirs.push(homeDir);
    return homeDir;
  }

  it('configures managed inference without writing the scoped token to disk', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'roomote/default',
        ROOMOTE_CLOUD_INFERENCE_BASE_URL:
          'http://roomote-cloud:4100/inference/v1/',
        ROOMOTE_CLOUD_INFERENCE_TOKEN: 'scoped-runtime-token',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.roomote).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Roomote Managed Inference',
      options: {
        baseURL: 'http://roomote-cloud:4100/inference/v1',
        apiKey: '{env:ROOMOTE_CLOUD_INFERENCE_TOKEN}',
      },
      models: {
        default: { name: 'Roomote Default' },
      },
    });
    expect(result.configContent).not.toContain('scoped-runtime-token');
  });

  it('routes Bedrock models through the Mantle Anthropic endpoint', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/anthropic.claude-haiku-4-5',
        R_MODEL_REASONING_EFFORT: 'high',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'us-west-2',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['bedrock-mantle']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      name: 'Amazon Bedrock',
      options: {
        baseURL: 'https://bedrock-mantle.us-west-2.api.aws/anthropic/v1',
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        'anthropic.claude-haiku-4-5': {
          options: {
            thinking: { type: 'enabled', budgetTokens: 16_000 },
          },
        },
      },
    });
    expect(result.configContent).not.toContain('bedrock-key');
  });

  it('defaults Bedrock Mantle to us-east-1', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/anthropic.claude-sonnet-5',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
      },
    });

    expect(result.configContent).toContain(
      'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1',
    );
  });

  it('rejects invalid AWS regions before building a provider URL', () => {
    expect(() =>
      generateOpenCodeConfig({
        homeDir: createHomeDir(),
        runtimeEnv: {
          R_MODEL: 'bedrock-mantle/anthropic.claude-sonnet-5',
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
          AWS_REGION: 'https://example.com',
        },
      }),
    ).toThrow('AWS_REGION must be a valid AWS region');
  });

  it('materializes inline Google Vertex credentials before OpenCode starts', () => {
    const homeDir = createHomeDir();
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'vertex-project',
      private_key: 'test-private-key',
      client_email: 'roomote@vertex-project.iam.gserviceaccount.com',
    });
    const runtimeEnv = {
      R_MODEL: 'google-vertex/gemini-3.5-flash',
      GOOGLE_APPLICATION_CREDENTIALS: `  ${credentialsJson}\n`,
      GOOGLE_VERTEX_PROJECT: 'vertex-project',
      GOOGLE_VERTEX_LOCATION: 'global',
    };

    generateOpenCodeConfig({ homeDir, runtimeEnv });

    const credentialsPath = runtimeEnv.GOOGLE_APPLICATION_CREDENTIALS;
    expect(credentialsPath).toBe(
      join(
        homeDir,
        '.local',
        'share',
        'opencode',
        'google-application-credentials.json',
      ),
    );
    expect(readFileSync(credentialsPath, 'utf8')).toBe(
      `  ${credentialsJson}\n`,
    );
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('leaves Google Vertex credential file paths unchanged', () => {
    const runtimeEnv = {
      R_MODEL: 'google-vertex/gemini-3.5-flash',
      GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google-credentials.json',
      GOOGLE_VERTEX_PROJECT: 'vertex-project',
    };

    generateOpenCodeConfig({ homeDir: createHomeDir(), runtimeEnv });

    expect(runtimeEnv.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      '/run/secrets/google-credentials.json',
    );
  });
});
