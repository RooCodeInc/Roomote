import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateOpenCodeConfig,
  rematerializeOpenCodeCredentialFiles,
} from './agent-home';

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

describe('rematerializeOpenCodeCredentialFiles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createHomeDir(): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'roomote-opencode-restore-'));
    tempDirs.push(homeDir);
    return homeDir;
  }

  function createLogger() {
    return { info: vi.fn(), warn: vi.fn() };
  }

  it('rewrites the Google credentials and auth files from env values', () => {
    const homeDir = createHomeDir();
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'vertex-project',
    });
    const authJson = JSON.stringify({ openai: { type: 'oauth' } });

    const { failedSteps } = rematerializeOpenCodeCredentialFiles({
      homeDir,
      runtimeEnv: {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
        OPENCODE_AUTH_CONTENT: authJson,
      },
      logger: createLogger(),
    });

    expect(failedSteps).toEqual([]);

    const dataDir = join(homeDir, '.local', 'share', 'opencode');
    expect(
      readFileSync(
        join(dataDir, 'google-application-credentials.json'),
        'utf8',
      ),
    ).toBe(credentialsJson);
    expect(readFileSync(join(dataDir, 'auth.json'), 'utf8')).toBe(authJson);
    expect(
      statSync(join(dataDir, 'google-application-credentials.json')).mode &
        0o777,
    ).toBe(0o600);
    expect(statSync(join(dataDir, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite the caller env or write files for absent values', () => {
    const homeDir = createHomeDir();
    const runtimeEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google-credentials.json',
    };

    const { failedSteps } = rematerializeOpenCodeCredentialFiles({
      homeDir,
      runtimeEnv,
      logger: createLogger(),
    });

    expect(failedSteps).toEqual([]);
    // A file-path value is not inline JSON, so nothing is written.
    expect(
      existsSync(
        join(
          homeDir,
          '.local',
          'share',
          'opencode',
          'google-application-credentials.json',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json')),
    ).toBe(false);
    expect(runtimeEnv.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      '/run/secrets/google-credentials.json',
    );
  });

  it('respects the task XDG data dir when rewriting files', () => {
    const homeDir = createHomeDir();
    const dataHome = join(homeDir, 'xdg-data');
    const credentialsJson = JSON.stringify({ type: 'service_account' });

    const { failedSteps } = rematerializeOpenCodeCredentialFiles({
      homeDir,
      runtimeEnv: {
        XDG_DATA_HOME: dataHome,
        GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
      },
      logger: createLogger(),
    });

    expect(failedSteps).toEqual([]);
    expect(
      readFileSync(
        join(dataHome, 'opencode', 'google-application-credentials.json'),
        'utf8',
      ),
    ).toBe(credentialsJson);
  });

  it('reports failed steps instead of throwing on write failures', () => {
    const homeDir = createHomeDir();
    // Occupy the data-dir path with a file so mkdir fails.
    const dataParent = join(homeDir, '.local', 'share');
    mkdirSync(dataParent, { recursive: true });
    writeFileSync(join(dataParent, 'opencode'), 'not a directory');

    const logger = createLogger();
    const { failedSteps } = rematerializeOpenCodeCredentialFiles({
      homeDir,
      runtimeEnv: {
        GOOGLE_APPLICATION_CREDENTIALS: JSON.stringify({ type: 'sa' }),
        OPENCODE_AUTH_CONTENT: '{}',
      },
      logger,
    });

    expect(failedSteps).toEqual([
      'rewrite Google application credentials file',
      'rewrite OpenCode auth file',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
