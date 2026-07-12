import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateOpenCodeConfig } from './agent-home';

describe('generateOpenCodeConfig Amazon Bedrock support', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createHomeDir(): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'roomote-bedrock-'));
    tempDirs.push(homeDir);
    return homeDir;
  }

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
});
