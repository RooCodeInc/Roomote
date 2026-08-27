import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createIntegrationMcpInstructions,
  generateOpenCodeConfig,
  seedRuntimeHomeMiseGlobalConfig,
} from './agent-home';
import { OPENCODE_IDENTITY_PLUGIN_SCRIPT } from '@roomote/cloud-agents';

describe('createIntegrationMcpInstructions', () => {
  it.each(['gbrain', 'supermemory'])(
    'injects shared memory lifecycle guidance for %s',
    (name) => {
      const instructions = createIntegrationMcpInstructions([
        { type: 'remote', name, url: 'https://example.com/mcp' },
      ]);

      expect(instructions).toContain(
        'before any other context or work tool call',
      );
      expect(instructions).toContain(
        'At task completion, proactively save concise durable learnings',
      );
    },
  );

  it('does not infer memory guidance from a custom server name', () => {
    expect(
      createIntegrationMcpInstructions([
        {
          type: 'remote',
          name: 'team-memory',
          url: 'https://example.com/mcp',
        },
      ]),
    ).toBeUndefined();
  });

  it('keeps ordinary integration guidance provider-specific', () => {
    const instructions = createIntegrationMcpInstructions([
      {
        type: 'remote',
        name: 'notion',
        url: 'https://example.com/mcp',
      },
    ]);

    expect(instructions).toContain('# Connected integration: Notion');
    expect(instructions).not.toContain(
      'before any other context or work tool call',
    );
  });

  it('assigns the initial recall to only the first installed memory server', () => {
    const instructions = createIntegrationMcpInstructions([
      { type: 'remote', name: 'gbrain', url: 'https://example.com/brain' },
      {
        type: 'remote',
        name: 'supermemory',
        url: 'https://example.com/supermemory',
      },
    ]);

    expect(
      instructions?.match(/first normal context or work tool call/g),
    ).toHaveLength(1);
    expect(instructions).toContain(
      'Another installed memory server owns the required initial recall',
    );
    expect(instructions).toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(instructions).toContain('save_task_memory');
  });

  it('does not inject Brain guidance when gbrain is a secondary memory server', () => {
    const instructions = createIntegrationMcpInstructions([
      {
        type: 'remote',
        name: 'supermemory',
        url: 'https://example.com/supermemory',
      },
      { type: 'remote', name: 'gbrain', url: 'https://example.com/brain' },
    ]);

    expect(instructions).not.toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(instructions).not.toContain('save_task_memory');
  });
});

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

  it('installs the Roomote identity plugin for standard task sessions', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openrouter/openai/gpt-5.6-terra',
        OPENROUTER_API_KEY: 'openrouter-key',
      },
    });

    expect(
      readFileSync(
        join(result.openCodeConfigDir, 'plugins', 'roomote-identity.js'),
        'utf8',
      ),
    ).toBe(OPENCODE_IDENTITY_PLUGIN_SCRIPT);
  });

  it('applies the per-task reasoning effort to a launch-time model override', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openrouter/openai/gpt-5.6-terra',
        R_MODEL_REASONING_EFFORT: 'medium',
        OPENROUTER_API_KEY: 'openrouter-key',
      },
      model: 'openrouter/z-ai/glm-5.2',
      reasoningEffortOverride: 'high',
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.openrouter).toMatchObject({
      models: {
        'z-ai/glm-5.2': {
          options: { reasoning: { effort: 'high' } },
        },
        'openai/gpt-5.6-terra': {
          options: { reasoning: { effort: 'medium' } },
        },
      },
    });
  });

  it('rewrites a Bedrock Mantle OpenAI launch-time model override', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/anthropic.claude-sonnet-5',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
      },
      model: 'bedrock-mantle/openai.gpt-5.6-luna',
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { models?: Record<string, unknown> }>;
    };

    expect(result.model).toBe('bedrock-mantle-openai/openai.gpt-5.6-luna');
    expect(
      config.provider['bedrock-mantle-openai']?.models?.['openai.gpt-5.6-luna'],
    ).toBeDefined();
  });

  it('routes native Bedrock OpenAI models through the Mantle Responses provider', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'amazon-bedrock/openai.gpt-5.6-sol',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'eu-west-1',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'AWS_BEARER_TOKEN_BEDROCK',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { models?: Record<string, unknown> }>;
    };

    expect(config.provider['bedrock-mantle-openai']).toMatchObject({
      options: {
        baseURL:
          'https://api.example.com/api/inference/bedrock-mantle-openai/v1',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
      models: {
        'openai.gpt-5.6-sol': {},
      },
    });
    expect(config.provider['amazon-bedrock']).toBeUndefined();
  });

  it('ignores a disabled launch-time model override', () => {
    const runtimeEnv = {
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
      MISTRAL_API_KEY: 'mistral-key',
    };

    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv,
      model: 'mistral/mistral-large-latest',
    });

    expect(result.model).toBeUndefined();
    expect(result.configContent).not.toContain('mistral/');
    expect(runtimeEnv.MISTRAL_API_KEY).toBeUndefined();
  });

  it('leaves a model override without reasoning options when no per-task effort is set', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openrouter/openai/gpt-5.6-terra',
        R_MODEL_REASONING_EFFORT: 'medium',
        OPENROUTER_API_KEY: 'openrouter-key',
      },
      model: 'openrouter/z-ai/glm-5.2',
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };
    const openrouter = config.provider.openrouter as {
      models?: Record<string, unknown>;
    };

    expect(openrouter.models?.['z-ai/glm-5.2']).toBeUndefined();
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

  it('routes Bedrock OpenAI models through the Mantle OpenAI endpoint', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/openai.gpt-5.6-terra',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'us-west-2',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['bedrock-mantle-openai']).toMatchObject({
      npm: '@ai-sdk/openai',
      name: 'Amazon Bedrock',
      options: {
        baseURL: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1',
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        'openai.gpt-5.6-terra': {},
      },
    });
    expect(config.provider['bedrock-mantle']).toBeUndefined();
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

  it('registers native Amazon Bedrock models without overriding the direct endpoint', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'amazon-bedrock/eu.anthropic.claude-sonnet-5',
        R_MODEL_REASONING_EFFORT: 'high',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'eu-west-1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['amazon-bedrock']).toMatchObject({
      npm: '@ai-sdk/amazon-bedrock',
      name: 'Amazon Bedrock',
      options: {
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        'eu.anthropic.claude-sonnet-5': {
          name: 'eu.anthropic.claude-sonnet-5',
          options: {
            reasoningConfig: {
              type: 'adaptive',
              maxReasoningEffort: 'high',
              display: 'summarized',
            },
          },
        },
      },
    });
    expect(result.configContent).not.toContain('baseURL');
    expect(result.configContent).not.toContain('bedrock-key');
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

  it('rebases gateway-covered providers onto the inference gateway', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'anthropic/claude-sonnet-5',
        R_SMALL_MODEL: 'google/gemini-3.5-flash',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'ANTHROPIC_API_KEY,GEMINI_API_KEY',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.anthropic).toMatchObject({
      options: {
        baseURL: 'https://api.example.com/api/inference/anthropic/v1',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
    });
    expect(config.provider.google).toMatchObject({
      options: {
        baseURL: 'https://api.example.com/api/inference/google/v1beta',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
    });
  });

  it('keeps OpenRouter attribution headers when rebasing onto the gateway', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openrouter/anthropic/claude-sonnet-5',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'OPENROUTER_API_KEY',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: {
        openrouter: { options: Record<string, unknown> };
      };
    };

    expect(config.provider.openrouter.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/openrouter/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      headers: expect.objectContaining({}) as Record<string, string>,
    });
  });

  it('rebases managed Roomote inference onto its separate gateway route', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'roomote/openai/gpt-5.6-luna',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'R_TRIAL_OPENROUTER_API_KEY',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: { roomote: { options: Record<string, unknown> } };
    };

    expect(config.provider.roomote.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/roomote/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('binds OpenCode Go to its dedicated key in direct mode', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'opencode-go/kimi-k2.7-code',
        OPENCODE_GO_API_KEY: 'go-key',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider['opencode-go']?.options).toMatchObject({
      apiKey: '{env:OPENCODE_GO_API_KEY}',
    });
    expect(result.configContent).not.toContain('go-key');
  });

  it('rebases OpenCode Go onto its inference gateway route', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'opencode-go/kimi-k2.7-code',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'OPENCODE_GO_API_KEY',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider['opencode-go']?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/opencode-go/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('rebases Azure providers onto the inference gateway without a /v1 suffix', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'azure/gpt-5.6-terra',
        R_SMALL_MODEL: 'azure-cognitive-services/gpt-5.6-luna',
        AZURE_RESOURCE_NAME: 'openai-resource',
        AZURE_COGNITIVE_SERVICES_RESOURCE_NAME: 'foundry-resource',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS:
          'AZURE_API_KEY,AZURE_COGNITIVE_SERVICES_API_KEY',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider.azure?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/azure',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
    expect(config.provider['azure-cognitive-services']?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/azure-cognitive-services',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('leaves Azure providers on their native endpoints in direct mode', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'azure/gpt-5.6-terra',
        R_SMALL_MODEL: 'azure-cognitive-services/gpt-5.6-luna',
        AZURE_API_KEY: 'azure-key',
        AZURE_RESOURCE_NAME: 'openai-resource',
        AZURE_COGNITIVE_SERVICES_API_KEY: 'foundry-key',
        AZURE_COGNITIVE_SERVICES_RESOURCE_NAME: 'foundry-resource',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(result.configContent).not.toContain('baseURL');
    expect(result.configContent).not.toContain('ROOMOTE_CLOUD_TOKEN');
    expect(config.provider.azure).toBeUndefined();
    expect(config.provider['azure-cognitive-services']?.options).toMatchObject({
      apiKey: '{env:AZURE_COGNITIVE_SERVICES_API_KEY}',
    });
  });

  it('binds the Foundry-specific API key when Azure OpenAI is not configured', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'azure-cognitive-services/gpt-5.6-terra',
        AZURE_COGNITIVE_SERVICES_API_KEY: 'foundry-key',
        AZURE_COGNITIVE_SERVICES_RESOURCE_NAME: 'foundry-resource',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider['azure-cognitive-services']?.options).toMatchObject({
      apiKey: '{env:AZURE_COGNITIVE_SERVICES_API_KEY}',
    });
  });

  it('rebases Bedrock Mantle onto the gateway while keeping its model config', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/anthropic.claude-sonnet-5',
        AWS_REGION: 'us-west-2',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'AWS_BEARER_TOKEN_BEDROCK',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['bedrock-mantle']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      options: {
        baseURL: 'https://api.example.com/api/inference/bedrock-mantle/v1',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
      models: {
        'anthropic.claude-sonnet-5': {},
      },
    });
  });

  it('rebases Bedrock Mantle OpenAI models onto the gateway', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'bedrock-mantle/openai.gpt-5.6-terra',
        AWS_REGION: 'us-west-2',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'AWS_BEARER_TOKEN_BEDROCK',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['bedrock-mantle-openai']).toMatchObject({
      npm: '@ai-sdk/openai',
      options: {
        baseURL:
          'https://api.example.com/api/inference/bedrock-mantle-openai/v1',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
      models: {
        'openai.gpt-5.6-terra': {},
      },
    });
    expect(config.provider['bedrock-mantle']).toBeUndefined();
  });

  it('rebases native Amazon Bedrock models onto the gateway', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'amazon-bedrock/eu.anthropic.claude-sonnet-5',
        AWS_REGION: 'eu-west-1',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'AWS_BEARER_TOKEN_BEDROCK',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['amazon-bedrock']).toMatchObject({
      npm: '@ai-sdk/amazon-bedrock',
      options: {
        baseURL: 'https://api.example.com/api/inference/amazon-bedrock',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
      models: {
        'eu.anthropic.claude-sonnet-5': {},
      },
    });
  });

  it('rebases the openai provider onto the ChatGPT gateway segment in gateway mode', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai/gpt-5.4-codex',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_CHATGPT: '1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider.openai?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/openai-chatgpt/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('enables ChatGPT fast mode on supported models without replacing reasoning options', () => {
    const runtimeEnv = {
      R_MODEL: 'openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'openai/gpt-5.6-luna',
      R_MODEL_REASONING_EFFORT: 'high',
      R_CHATGPT_FAST_MODE: '1',
    };
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv,
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        { models?: Record<string, { options?: Record<string, unknown> }> }
      >;
    };

    expect(config.provider.openai?.models?.['gpt-5.6-terra']?.options).toEqual({
      reasoningEffort: 'high',
      serviceTier: 'priority',
    });
    expect(config.provider.openai?.models?.['gpt-5.6-luna']?.options).toEqual({
      serviceTier: 'priority',
    });
    expect(runtimeEnv).not.toHaveProperty('R_CHATGPT_FAST_MODE');
  });

  it('rebases GitHub Copilot onto its OAuth-backed gateway segment', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'github-copilot/claude-haiku-4.5',
        R_MODEL_REASONING_EFFORT: 'medium',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_GITHUB_COPILOT: '1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider['github-copilot']?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/github-copilot',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
    // The env key enables the provider before OpenCode's custom-loader pass,
    // which is what registers the Copilot endpoint router (GPT-5+ models must
    // use /responses instead of /chat/completions).
    expect(config.provider['github-copilot']).toMatchObject({
      env: ['ROOMOTE_CLOUD_TOKEN'],
    });
    expect(config.provider['github-copilot']).toMatchObject({
      models: {
        'claude-haiku-4.5': {
          options: { thinking_budget: 8_000 },
        },
      },
    });
    expect(
      (
        config.provider['github-copilot'] as {
          models: Record<string, { options: Record<string, unknown> }>;
        }
      ).models['claude-haiku-4.5']?.options.reasoningEffort,
    ).toBeUndefined();
  });

  it('rebases xAI onto the gateway when the Grok subscription marker is set', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'xai/grok-4.5',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_XAI: '1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options?: Record<string, unknown> }>;
    };

    expect(config.provider.xai?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/xai/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('does not let legacy direct OAuth content bypass gateway rebasing', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai/gpt-5.4-codex',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference',
        R_INFERENCE_GATEWAY_KEYS: 'OPENAI_API_KEY',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth"}}',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.openai).toMatchObject({
      options: {
        baseURL: 'https://api.example.com/api/inference/openai/v1',
        apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
      },
    });
  });

  it('does not touch provider base URLs when no gateway URL is present', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'anthropic/claude-sonnet-5',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
    });

    expect(result.configContent).not.toContain('baseURL');
    expect(result.configContent).not.toContain('ROOMOTE_CLOUD_TOKEN');
  });

  it('configures selected OpenAI-compatible providers with direct-mode fallbacks', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'ollama/qwen3-coder',
        R_SMALL_MODEL: 'vllm/meta-llama/Llama-3.3-70B-Instruct',
        R_VISION_MODEL: 'litellm/gpt-4.1-mini',
        R_CODE_REVIEW_MODEL: 'openai-compatible/gpt-4o',
        VLLM_BASE_URL: 'https://vllm.example.com/v1',
        VLLM_API_KEY: 'vllm-key',
        LITELLM_BASE_URL: 'https://litellm.example.com/v1',
        LITELLM_API_KEY: 'litellm-key',
        OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_COMPATIBLE_API_KEY: 'compat-key',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider.ollama).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:11434/v1' },
      models: { 'qwen3-coder': { name: 'qwen3-coder' } },
    });
    expect(config.provider.ollama?.options.apiKey).toBe('ollama');
    expect(config.provider.vllm).toMatchObject({
      options: {
        baseURL: 'https://vllm.example.com/v1',
        apiKey: '{env:VLLM_API_KEY}',
      },
    });
    expect(config.provider.litellm).toMatchObject({
      options: {
        baseURL: 'https://litellm.example.com/v1',
        apiKey: '{env:LITELLM_API_KEY}',
      },
    });
    expect(config.provider['openai-compatible']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://proxy.example.com/v1',
        apiKey: '{env:OPENAI_COMPATIBLE_API_KEY}',
      },
      models: { 'gpt-4o': { name: 'gpt-4o' } },
    });
  });

  it('marks only the configured OpenAI-compatible vision model as attachment-capable', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible/text-model',
        R_VISION_MODEL: 'openai-compatible/vision-model',
        OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_COMPATIBLE_API_KEY: 'compat-key',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        { models: Record<string, Record<string, unknown>> }
      >;
    };
    const models = config.provider['openai-compatible']?.models;

    expect(models?.['vision-model']).toMatchObject({
      name: 'vision-model',
      attachment: true,
      modalities: {
        input: ['text', 'image', 'video'],
        output: ['text'],
      },
    });
    expect(models?.['text-model']).not.toHaveProperty('attachment');
    expect(models?.['text-model']).not.toHaveProperty('modalities');
  });

  it('falls back to the OpenAI-compatible coding model when no vision model is configured', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible/vision-model',
        OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_COMPATIBLE_API_KEY: 'compat-key',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        { models: Record<string, Record<string, unknown>> }
      >;
    };

    expect(
      config.provider['openai-compatible']?.models['vision-model'],
    ).toMatchObject({
      attachment: true,
      modalities: {
        input: ['text', 'image', 'video'],
        output: ['text'],
      },
    });
  });

  it('isolates visual and proof agents from unrelated MCP tool schemas', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openrouter/openai/gpt-5.6-terra',
        R_VISION_MODEL: 'openrouter/google/gemini-3.6-flash',
        ROOMOTE_PROOF_BROWSER_TARGET: 'http://127.0.0.1:3000',
        OPENROUTER_API_KEY: 'openrouter-key',
      },
      mcpServers: [
        {
          type: 'remote',
          name: 'roomote',
          url: 'https://roomote.example.com/mcp',
        },
        {
          type: 'remote',
          name: 'pylon',
          url: 'https://pylon.example.com/mcp',
        },
        {
          type: 'local',
          name: 'custom-tools',
          command: 'custom-mcp',
        },
      ],
    });
    const config = JSON.parse(result.configContent) as {
      agent: Record<string, { tools?: Record<string, boolean> }>;
      mcp: Record<string, { timeout?: number }>;
    };

    expect(config.mcp.roomote?.timeout).toBe(600_000);
    expect(config.mcp.pylon?.timeout).toBeUndefined();
    expect(config.mcp['custom-tools']?.timeout).toBeUndefined();

    expect(config.agent.visual?.tools).toMatchObject({
      'roomote_*': false,
      'pylon_*': false,
      'custom-tools_*': false,
    });

    for (const agentName of ['judge', 'advisor']) {
      expect(config.agent[agentName]?.tools).not.toHaveProperty('roomote_*');
      expect(config.agent[agentName]?.tools).not.toHaveProperty('pylon_*');
      expect(config.agent[agentName]?.tools).not.toHaveProperty(
        'custom-tools_*',
      );
    }

    expect(config.agent['proof-runner']?.tools).toMatchObject({
      'pylon_*': false,
      'custom-tools_*': false,
      roomote_manage_source_control: false,
    });
    expect(config.agent['proof-runner']?.tools).not.toHaveProperty('roomote_*');
    expect(config.agent['proof-runner']?.tools).not.toHaveProperty(
      'roomote_manage_artifacts',
    );
    expect(config.agent.general?.tools).not.toHaveProperty('pylon_*');
    expect(config.agent.architect?.tools).toBeUndefined();
  });

  it('prefixes bare LiteLLM route names when LITELLM_BASE_URL is set', () => {
    const homeDir = createHomeDir();
    const result = generateOpenCodeConfig({
      homeDir,
      runtimeEnv: {
        R_MODEL: 'qwen3.6-35b-local',
        R_SMALL_MODEL: 'coding',
        LITELLM_BASE_URL: 'https://litellm.example.com/v1',
        LITELLM_API_KEY: 'litellm-key',
      },
    });
    const globalConfig = JSON.parse(
      readFileSync(join(result.openCodeConfigDir, 'opencode.json'), 'utf8'),
    ) as {
      model: string;
      small_model?: string;
      provider: Record<string, { models?: Record<string, unknown> }>;
    };

    expect(globalConfig.model).toBe('litellm/qwen3.6-35b-local');
    expect(globalConfig.small_model).toBe('litellm/coding');
    expect(globalConfig.provider.litellm?.models).toMatchObject({
      'qwen3.6-35b-local': { name: 'qwen3.6-35b-local' },
      coding: { name: 'coding' },
    });
    expect(result.configContent).toContain('litellm');
  });

  it('writes catalog pricing into custom-provider model config', () => {
    const runtimeEnv = {
      R_MODEL: 'roomote/openai/gpt-5.6-luna',
      R_TRIAL_OPENROUTER_API_KEY: 'sk-or-trial',
      R_TASK_MODEL_COSTS: JSON.stringify({
        'roomote/openai/gpt-5.6-luna': { input: 2, output: 10 },
      }),
      R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference/',
    };
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv,
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        { models: Record<string, { cost?: Record<string, number> }> }
      >;
    };

    expect(
      config.provider.roomote?.models['openai/gpt-5.6-luna']?.cost,
    ).toEqual({ input: 2, output: 10 });
    expect(runtimeEnv).not.toHaveProperty('R_TASK_MODEL_COSTS');
  });

  it('configures trusted LiteLLM context limits for proactive compaction', () => {
    const runtimeEnv = {
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_TASK_MODEL_CONTEXT_WINDOWS: JSON.stringify({
        'litellm/qwen3.6:35b-unsloth': 210_176,
      }),
      R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference/',
    };
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv,
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        {
          models: Record<string, { limit?: Record<string, number> }>;
          options?: Record<string, unknown>;
        }
      >;
    };

    expect(
      config.provider.litellm?.models['qwen3.6:35b-unsloth']?.limit,
    ).toEqual({
      context: 210_176,
      output: 32_000,
    });
    expect(config.provider.litellm?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/litellm/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
    expect(runtimeEnv).not.toHaveProperty('R_TASK_MODEL_CONTEXT_WINDOWS');
  });

  it('configures named openai-compatible connections separately', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible-company-proxy/gpt-4o',
        R_SMALL_MODEL: 'openai-compatible-local/qwen3',
        OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL:
          'https://proxy.example.com/v1',
        OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: 'proxy-key',
        OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL: 'Corp Proxy',
        OPENAI_COMPATIBLE_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<
        string,
        { name?: string; options: Record<string, unknown> }
      >;
    };

    expect(config.provider['openai-compatible-company-proxy']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenAI-compatible (Corp Proxy)',
      options: {
        baseURL: 'https://proxy.example.com/v1',
        apiKey: '{env:OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY}',
      },
      models: { 'gpt-4o': { name: 'gpt-4o' } },
    });
    expect(config.provider['openai-compatible-local']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenAI-compatible (Local)',
      options: {
        baseURL: 'http://127.0.0.1:8080/v1',
      },
      models: { qwen3: { name: 'qwen3' } },
    });
    expect(
      config.provider['openai-compatible-local']?.options.apiKey,
    ).toBeUndefined();
  });

  it('ignores invalid openai-compatible env segments from shared parsing', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible/gpt-4o',
        OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
        // Double underscore is rejected by shared named-env validation
        OPENAI_COMPATIBLE_BAD__SLUG_BASE_URL: 'https://bad.example.com/v1',
        // Leading digit env segment is invalid
        OPENAI_COMPATIBLE_9PROXY_BASE_URL: 'https://nine.example.com/v1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['openai-compatible']).toBeDefined();
    expect(config.provider['openai-compatible-bad--slug']).toBeUndefined();
    expect(config.provider['openai-compatible-9proxy']).toBeUndefined();
  });

  it('does not fall back named openai-compatible connections to OPENAI_* credentials', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible-company-proxy/gpt-4o',
        OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL:
          'https://proxy.example.com/v1',
        OPENAI_API_KEY: 'sk-openai-should-not-leak',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider['openai-compatible-company-proxy']).toMatchObject({
      options: {
        baseURL: 'https://proxy.example.com/v1',
      },
    });
    expect(
      config.provider['openai-compatible-company-proxy']?.options.apiKey,
    ).toBeUndefined();
  });

  it('does not fall back openai-compatible to OPENAI_* credentials', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible/gpt-4o',
        OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_API_KEY: 'sk-openai-should-not-leak',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider['openai-compatible']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://proxy.example.com/v1',
      },
      models: { 'gpt-4o': { name: 'gpt-4o' } },
    });
    expect(
      config.provider['openai-compatible']?.options.apiKey,
    ).toBeUndefined();
  });

  it('rebases gateway-backed openai-compatible providers with the run token', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'openai-compatible/gpt-4o',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference/',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider['openai-compatible']?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/openai-compatible/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('rebases gateway-backed compatible providers without an Ollama key', () => {
    const result = generateOpenCodeConfig({
      homeDir: createHomeDir(),
      runtimeEnv: {
        R_MODEL: 'ollama/qwen3-coder',
        R_SMALL_MODEL: 'vllm/meta-llama/Llama-3.3-70B-Instruct',
        R_VISION_MODEL: 'litellm/gpt-4.1-mini',
        R_INFERENCE_GATEWAY_URL: 'https://api.example.com/api/inference/',
      },
    });
    const config = JSON.parse(result.configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider.ollama?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/ollama/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
    expect(config.provider.vllm?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/vllm/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
    expect(config.provider.litellm?.options).toMatchObject({
      baseURL: 'https://api.example.com/api/inference/litellm/v1',
      apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
    });
  });

  it('strips disabled-provider credentials and removes a stale Vertex file', () => {
    const homeDir = createHomeDir();
    const credentialsPath = join(
      homeDir,
      '.local',
      'share',
      'opencode',
      'google-application-credentials.json',
    );
    mkdirSync(join(homeDir, '.local', 'share', 'opencode'), {
      recursive: true,
    });
    writeFileSync(credentialsPath, 'stale-credentials');
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'vertex-project',
      private_key: 'test-private-key',
      client_email: 'roomote@vertex-project.iam.gserviceaccount.com',
    });
    const runtimeEnv = {
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'mistral/mistral-large-latest',
      R_VISION_MODEL: 'google-vertex/gemini-3.5-flash',
      GOOGLE_APPLICATION_CREDENTIALS: `  ${credentialsJson}\n`,
      MISTRAL_API_KEY: 'mistral-key',
      GOOGLE_VERTEX_PROJECT: 'vertex-project',
      GOOGLE_VERTEX_LOCATION: 'global',
    };

    const result = generateOpenCodeConfig({ homeDir, runtimeEnv });

    expect(runtimeEnv.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(runtimeEnv.MISTRAL_API_KEY).toBeUndefined();
    expect(result.configContent).toContain('openrouter/openai/gpt-5.6-terra');
    expect(result.configContent).not.toContain('mistral/');
    expect(result.configContent).not.toContain('google-vertex/');
    expect(runtimeEnv.R_MODEL).toBeUndefined();
    expect(runtimeEnv.R_SMALL_MODEL).toBeUndefined();
    expect(runtimeEnv.R_VISION_MODEL).toBeUndefined();
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('fails closed when a stale Google Vertex credential cannot be removed', () => {
    const homeDir = createHomeDir();
    const credentialsPath = join(
      homeDir,
      '.local',
      'share',
      'opencode',
      'google-application-credentials.json',
    );
    mkdirSync(credentialsPath, { recursive: true });
    writeFileSync(join(credentialsPath, 'credential.json'), '{}');
    const runtimeEnv = {
      R_MODEL: 'google-vertex/gemini-3.5-flash',
      GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google-credentials.json',
      GOOGLE_VERTEX_PROJECT: 'vertex-project',
    };

    expect(() => generateOpenCodeConfig({ homeDir, runtimeEnv })).toThrow(
      'Failed to remove disabled Google Vertex credentials before starting OpenCode',
    );
  });
});

describe('seedRuntimeHomeMiseGlobalConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeMiseConfig(homeDir: string, content: string): string {
    const configDir = join(homeDir, '.config', 'mise');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.toml');
    writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

  it('copies the worker home global config into the runtime home', () => {
    const sourceHomeDir = createDir('roomote-mise-source-');
    const homeDir = createDir('roomote-mise-runtime-');
    writeMiseConfig(sourceHomeDir, '[tools]\nnodejs = "22"\n');

    expect(seedRuntimeHomeMiseGlobalConfig({ homeDir, sourceHomeDir })).toBe(
      true,
    );
    expect(
      readFileSync(join(homeDir, '.config', 'mise', 'config.toml'), 'utf8'),
    ).toBe('[tools]\nnodejs = "22"\n');
  });

  it('leaves an existing runtime home config untouched', () => {
    const sourceHomeDir = createDir('roomote-mise-source-');
    const homeDir = createDir('roomote-mise-runtime-');
    writeMiseConfig(sourceHomeDir, '[tools]\nnodejs = "22"\n');
    writeMiseConfig(homeDir, '[tools]\nnodejs = "20"\n');

    expect(seedRuntimeHomeMiseGlobalConfig({ homeDir, sourceHomeDir })).toBe(
      false,
    );
    expect(
      readFileSync(join(homeDir, '.config', 'mise', 'config.toml'), 'utf8'),
    ).toBe('[tools]\nnodejs = "20"\n');
  });

  it('does nothing when the worker home has no global config', () => {
    const sourceHomeDir = createDir('roomote-mise-source-');
    const homeDir = createDir('roomote-mise-runtime-');

    expect(seedRuntimeHomeMiseGlobalConfig({ homeDir, sourceHomeDir })).toBe(
      false,
    );
    expect(existsSync(join(homeDir, '.config', 'mise', 'config.toml'))).toBe(
      false,
    );
  });

  it('does nothing when the runtime home is the worker home', () => {
    const homeDir = createDir('roomote-mise-source-');
    writeMiseConfig(homeDir, '[tools]\nnodejs = "22"\n');

    expect(
      seedRuntimeHomeMiseGlobalConfig({ homeDir, sourceHomeDir: homeDir }),
    ).toBe(false);
  });
});
