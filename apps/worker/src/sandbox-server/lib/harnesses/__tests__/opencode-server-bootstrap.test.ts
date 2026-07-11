import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('opencode-server bootstrap', () => {
  const tempDirs: string[] = [];
  // Pinned literal contract: the Slack-posting tools excluded from every
  // generated subagent config and the built-in general agent (see
  // apps/worker/src/run-task/slack-posting-tools.ts).
  const slackPostingToolExclusions = {
    roomote_send_chat_reply: false,
    roomote_send_chat_reaction_emoji: false,
    roomote_post_to_slack_channel: false,
    roomote_reply_to_slack_thread: false,
  };

  function createLogger() {
    return {
      runId: 1,
      filePath: '/tmp/test.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
  }

  function createTempHome(): string {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-direct-opencode-test-home-'),
    );
    tempDirs.push(tempDir);
    return tempDir;
  }

  function readOpenCodeConfig(homeDir: string): string {
    return fs.readFileSync(
      path.join(homeDir, '.config', 'opencode', 'opencode.json'),
      'utf8',
    );
  }

  function readOpenCodeSlackPlugin(homeDir: string): string {
    return fs.readFileSync(
      path.join(
        homeDir,
        '.config',
        'opencode',
        'plugins',
        'roomote-slack-hooks.js',
      ),
      'utf8',
    );
  }

  function createDirectHarnessRuntimeEnv(
    homeDir: string,
  ): Record<string, string> {
    return {
      HOME: homeDir,
      R_MODEL: 'test-provider/main-model',
      R_SMALL_MODEL: 'test-provider/small-model',
      PROVIDER_API_KEY: 'provider-key',
    };
  }

  function readRoomoteOpenCodeOverlay(
    runtimeEnv: Record<string, string>,
  ): Record<string, unknown> {
    const configContent = runtimeEnv.OPENCODE_CONFIG_CONTENT;

    if (!configContent) {
      throw new Error('Missing OPENCODE_CONFIG_CONTENT');
    }

    return JSON.parse(configContent) as Record<string, unknown>;
  }

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('moves literal remote MCP header values into env vars before preparing the runtime overlay', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      mcpServers: {
        linear: {
          type: 'streamable-http',
          url: 'https://api.test.com/api/mcp/linear',
          headers: {
            Authorization: 'Bearer actor-secret-token',
            'X-Roomote-Bypass': 'bypass-secret',
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });

    const configContent = runtimeEnv.OPENCODE_CONFIG_CONTENT ?? '';
    const config = readRoomoteOpenCodeOverlay(runtimeEnv);

    expect(runtimeEnv).toMatchObject({
      ROOMOTE_DIRECT_MCP_BEARER_TOKEN_LINEAR: 'actor-secret-token',
      ROOMOTE_DIRECT_MCP_HEADER_LINEAR_X_ROOMOTE_BYPASS: 'bypass-secret',
      ROOMOTE_DIRECT_MCP_HEADER_LINEAR_X_MCP_CLIENT: 'Roomote',
    });
    expect(config).toMatchObject({
      mcp: {
        linear: {
          headers: {
            Authorization:
              'Bearer {env:ROOMOTE_DIRECT_MCP_BEARER_TOKEN_LINEAR}',
            'X-Roomote-Bypass':
              '{env:ROOMOTE_DIRECT_MCP_HEADER_LINEAR_X_ROOMOTE_BYPASS}',
            'X-MCP-Client':
              '{env:ROOMOTE_DIRECT_MCP_HEADER_LINEAR_X_MCP_CLIENT}',
          },
        },
      },
    });
    expect(configContent).not.toContain('actor-secret-token');
    expect(configContent).not.toContain('bypass-secret');
  });

  it('preserves env-backed remote MCP headers without synthesizing new env vars', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        LINEAR_TOKEN: 'actor-secret-token',
        DOCS_REGION: 'us-east-1',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      mcpServers: {
        linear: {
          type: 'streamable-http',
          url: 'https://api.test.com/api/mcp/linear',
          headers: {
            Authorization: 'Bearer ${LINEAR_TOKEN}',
            'X-MCP-Region': '${DOCS_REGION}',
          },
        },
      },
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv);

    expect(config).toMatchObject({
      mcp: {
        linear: {
          headers: {
            Authorization: 'Bearer {env:LINEAR_TOKEN}',
            'X-MCP-Region': '{env:DOCS_REGION}',
          },
        },
      },
    });
    expect(runtimeEnv).not.toHaveProperty(
      'ROOMOTE_DIRECT_MCP_BEARER_TOKEN_LINEAR',
    );
    expect(runtimeEnv).not.toHaveProperty(
      'ROOMOTE_DIRECT_MCP_HEADER_LINEAR_X_MCP_REGION',
    );
  });

  it('injects integration usage instructions when an attached MCP integration defines them', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      mcpServers: {
        supermemory: {
          type: 'streamable-http',
          url: 'https://api.test.com/api/mcp/supermemory',
          headers: {
            Authorization: 'Bearer task-run-token',
          },
        },
      },
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      instructions?: string[];
    };
    const integrationInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-integration-instructions.md',
    );

    expect(config.instructions).toContain(integrationInstructionsPath);

    const content = fs.readFileSync(integrationInstructionsPath, 'utf8');

    expect(content).toContain('# Connected integration: Supermemory');
    expect(content).toContain('Recall early');
    expect(content).toContain('Save sparingly');
  });

  it('skips the integration usage instructions file when attached MCP servers define none', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      mcpServers: {
        linear: {
          type: 'streamable-http',
          url: 'https://api.test.com/api/mcp/linear',
          headers: {
            Authorization: 'Bearer task-run-token',
          },
        },
      },
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      instructions?: string[];
    };
    const integrationInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-integration-instructions.md',
    );

    expect(config.instructions ?? []).not.toContain(
      integrationInstructionsPath,
    );
    expect(fs.existsSync(integrationInstructionsPath)).toBe(false);
  });

  it('writes only developer instructions and skips the legacy system prompt file', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      developerInstructionsContent: 'Use the task tools.',
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      model?: string;
      small_model?: string;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      instructions?: string[];
    };
    const openCodeConfigDir = path.join(homeDir, '.config', 'opencode');
    const developerInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-developer-instructions.md',
    );
    const judgeModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-judge-model-instructions.md',
    );
    const advisorModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-advisor-model-instructions.md',
    );
    const systemPromptPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-system-prompt.md',
    );

    expect(baseConfig.model).toBe('test-provider/main-model');
    expect(baseConfig.small_model).toBe('test-provider/small-model');
    expect(config.instructions).toEqual([
      developerInstructionsPath,
      judgeModelInstructionsPath,
      advisorModelInstructionsPath,
    ]);
    expect(fs.readFileSync(developerInstructionsPath, 'utf8')).toBe(
      'Use the task tools.',
    );
    expect(fs.existsSync(systemPromptPath)).toBe(false);
  });

  it('configures a hidden visual subagent when the vision model differs from the coding model', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/vision-model',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const openCodeConfigDir = path.join(homeDir, '.config', 'opencode');
    const visualModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-visual-model-instructions.md',
    );
    const judgeModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-judge-model-instructions.md',
    );
    const advisorModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-advisor-model-instructions.md',
    );

    expect(baseConfig.agent?.visual).toMatchObject({
      description: expect.stringContaining('images'),
      mode: 'subagent',
      hidden: true,
      model: 'test-provider/vision-model',
      permission: {
        read: 'allow',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
      },
      tools: slackPostingToolExclusions,
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.instructions).toEqual([
      visualModelInstructionsPath,
      judgeModelInstructionsPath,
      advisorModelInstructionsPath,
    ]);
    expect(fs.readFileSync(visualModelInstructionsPath, 'utf8')).toContain(
      'visual',
    );
    expect(runtimeEnv).not.toHaveProperty('R_VISION_MODEL');
  });

  it('configures a hidden judge subagent when the code review model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_CODE_REVIEW_MODEL: 'test-provider/review-model',
        R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const openCodeConfigDir = path.join(homeDir, '.config', 'opencode');
    const judgeModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-judge-model-instructions.md',
    );
    const advisorModelInstructionsPath = path.join(
      openCodeConfigDir,
      'roomote-opencode-advisor-model-instructions.md',
    );

    expect(baseConfig.agent?.judge).toEqual({
      description:
        'Compares completed implementation against a plan or requested outcome and returns concise review findings.',
      mode: 'subagent',
      hidden: true,
      model: 'test-provider/review-model',
      options: { reasoningEffort: 'high' },
      prompt: expect.stringContaining('implementation review support'),
      permission: {
        read: 'allow',
        list: 'allow',
        glob: 'allow',
        grep: 'allow',
        external_directory: 'allow',
        webfetch: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        todowrite: 'deny',
        lsp: 'deny',
        skill: 'deny',
        question: 'deny',
      },
      tools: slackPostingToolExclusions,
    });
    expect(baseConfig.agent?.judge).toMatchObject({
      prompt: expect.stringContaining(
        'Avoid open-ended repository exploration',
      ),
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.instructions).toEqual([
      judgeModelInstructionsPath,
      advisorModelInstructionsPath,
    ]);
    expect(fs.readFileSync(judgeModelInstructionsPath, 'utf8')).toContain(
      'judge',
    );
    expect(fs.readFileSync(judgeModelInstructionsPath, 'utf8')).toContain(
      'Keep judge tool use minimal and targeted.',
    );
    expect(runtimeEnv).not.toHaveProperty('R_CODE_REVIEW_MODEL');
    expect(runtimeEnv).not.toHaveProperty(
      'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
    );
  });

  it('configures a hidden judge subagent with the coding model when no code review model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const judgeModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-judge-model-instructions.md',
    );
    const advisorModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-advisor-model-instructions.md',
    );

    expect(baseConfig.agent?.judge).toEqual({
      description:
        'Compares completed implementation against a plan or requested outcome and returns concise review findings.',
      mode: 'subagent',
      hidden: true,
      model: 'test-provider/main-model',
      prompt: expect.stringContaining('implementation review support'),
      permission: {
        read: 'allow',
        list: 'allow',
        glob: 'allow',
        grep: 'allow',
        external_directory: 'allow',
        webfetch: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        todowrite: 'deny',
        lsp: 'deny',
        skill: 'deny',
        question: 'deny',
      },
      tools: slackPostingToolExclusions,
    });
    expect(baseConfig.agent?.judge).toMatchObject({
      prompt: expect.stringContaining(
        'Avoid open-ended repository exploration',
      ),
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.instructions).toEqual([
      judgeModelInstructionsPath,
      advisorModelInstructionsPath,
    ]);
    expect(fs.readFileSync(judgeModelInstructionsPath, 'utf8')).toContain(
      'falls back to the active coding model',
    );
    expect(fs.readFileSync(judgeModelInstructionsPath, 'utf8')).toContain(
      'Start from the shipped diff, the plan, and the validation state',
    );
  });

  it('registers the architect primary agent unconditionally with the plan-mode permission matrix', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
    };

    // Without a planning model or reasoning override, the architect agent
    // carries no model/options so architect turns inherit the config's
    // top-level model.
    expect(baseConfig.agent?.architect).toEqual({
      description:
        'Roomote planning specialist that runs read-mostly plan-mode turns without changing repository-tracked files.',
      mode: 'primary',
      prompt: expect.stringContaining('planning specialist'),
      permission: {
        read: 'allow',
        list: 'allow',
        glob: 'allow',
        grep: 'allow',
        external_directory: 'allow',
        webfetch: 'allow',
        lsp: 'allow',
        todowrite: 'allow',
        question: 'allow',
        skill: 'allow',
        task: 'allow',
        bash: 'allow',
        edit: 'deny',
      },
    });
    // The prompt documents the repo-unchanged rule and the skill-load exit
    // contract so the model is never surprised by same-turn edit denials.
    expect(baseConfig.agent?.architect).toMatchObject({
      prompt: expect.stringContaining(
        'Keep repository-tracked files unchanged',
      ),
    });
    expect(baseConfig.agent?.architect).toMatchObject({
      prompt: expect.stringContaining(
        'load the `implement-changes` skill with the skill tool in that same turn',
      ),
    });
    expect(baseConfig.agent?.architect).toMatchObject({
      prompt: expect.stringContaining(
        'Never tell the user to start a new task.',
      ),
    });
    expect(config.agent).toEqual(baseConfig.agent);
  });

  it('overrides the architect agent model when a planning model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
        R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
    };

    expect(baseConfig.agent?.architect).toMatchObject({
      mode: 'primary',
      model: 'openrouter/anthropic/claude-opus-4.7',
      options: { reasoning: { effort: 'high' } },
    });
    // The built-in plan agent no longer receives a Roomote override.
    expect(baseConfig.agent?.plan).toBeUndefined();
    expect(config.agent).toEqual(baseConfig.agent);
    expect(runtimeEnv).not.toHaveProperty('R_PLANNING_MODEL');
    expect(runtimeEnv).not.toHaveProperty('R_PLANNING_MODEL_REASONING_EFFORT');
  });

  it('applies planning reasoning to the architect agent when no planning model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };

    expect(baseConfig.agent?.judge).toMatchObject({
      mode: 'subagent',
      model: 'test-provider/main-model',
    });
    expect(baseConfig.agent?.architect).toMatchObject({
      mode: 'primary',
      options: { reasoningEffort: 'high' },
    });
    expect(baseConfig.agent?.architect).not.toHaveProperty('model');
  });

  it('configures a hidden advisor subagent with the advisor model when a planning model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
        R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const advisorModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-advisor-model-instructions.md',
    );

    expect(baseConfig.agent?.advisor).toEqual({
      description: expect.stringContaining('stuck'),
      mode: 'subagent',
      model: 'openrouter/anthropic/claude-opus-4.7',
      options: { reasoning: { effort: 'high' } },
      prompt: expect.stringContaining('coding advisor support'),
      permission: {
        read: 'allow',
        list: 'allow',
        glob: 'allow',
        grep: 'allow',
        external_directory: 'allow',
        webfetch: 'allow',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        todowrite: 'deny',
        lsp: 'deny',
        skill: 'deny',
        question: 'deny',
      },
      tools: slackPostingToolExclusions,
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.instructions).toContain(advisorModelInstructionsPath);
    expect(fs.readFileSync(advisorModelInstructionsPath, 'utf8')).toContain(
      'advisor',
    );
    expect(fs.readFileSync(advisorModelInstructionsPath, 'utf8')).toContain(
      'delegate one focused consultation',
    );
  });

  it('configures a hidden advisor subagent with the coding model at the advisor reasoning level when no planning model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const advisorModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-advisor-model-instructions.md',
    );

    expect(baseConfig.agent?.advisor).toMatchObject({
      mode: 'subagent',
      model: 'test-provider/main-model',
      options: { reasoningEffort: 'high' },
    });
    expect(fs.readFileSync(advisorModelInstructionsPath, 'utf8')).toContain(
      'falls back to the active coding model',
    );
  });

  it('applies configured reasoning levels as per-model provider options and scrubs the env vars', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'openrouter/openai/gpt-vision',
        R_MODEL_REASONING_EFFORT: 'high',
        R_SMALL_MODEL_REASONING_EFFORT: 'low',
        R_VISION_MODEL_REASONING_EFFORT: 'medium',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, Record<string, unknown>>;
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    // Coding and helper models are distinct, so each gets its own per-model
    // reasoning options. `test-provider` is not a known special case, so the
    // generic `reasoningEffort` option shape applies.
    expect(baseConfig.provider?.['test-provider']?.models).toEqual({
      'main-model': { options: { reasoningEffort: 'high' } },
      'small-model': { options: { reasoningEffort: 'low' } },
    });
    // The vision level is scoped to the visual subagent through agent-level
    // options using the OpenRouter reasoning shape.
    expect(baseConfig.agent?.visual?.options).toEqual({
      reasoning: { effort: 'medium' },
    });

    expect(runtimeEnv).not.toHaveProperty('R_MODEL_REASONING_EFFORT');
    expect(runtimeEnv).not.toHaveProperty('R_SMALL_MODEL_REASONING_EFFORT');
    expect(runtimeEnv).not.toHaveProperty('R_VISION_MODEL_REASONING_EFFORT');
    expect(runtimeEnv).not.toHaveProperty(
      'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
    );
  });

  it('rewrites OpenRouter variant models to catalog base models with provider aliases', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv, model } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        HOME: homeDir,
        R_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
        R_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini:floor',
        R_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      model?: string;
      small_model?: string;
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      model?: string;
      small_model?: string;
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    // Roles use the catalog base models so OpenCode's model lookup succeeds
    // and catalog cost/limit metadata stays intact; routing variants become
    // per-model request options merged with the reasoning options.
    expect(model).toBeUndefined();
    expect(baseConfig.model).toBe('openrouter/z-ai/glm-5.2');
    expect(baseConfig.small_model).toBe('openrouter/openai/gpt-5.4-mini');
    expect(baseConfig.provider?.openrouter?.models).toEqual({
      'z-ai/glm-5.2': {
        options: {
          reasoning: { effort: 'high' },
          provider: { sort: 'throughput' },
        },
      },
      'openai/gpt-5.4-mini': {
        options: { provider: { sort: 'price' } },
      },
    });
    expect(config.provider?.openrouter?.models).toEqual(
      baseConfig.provider?.openrouter?.models,
    );
  });

  it('rewrites an OpenRouter variant task model override to its catalog base model', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv, model } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      model: 'openrouter/z-ai/glm-5.2:nitro',
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      model?: string;
      small_model?: string;
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    // The harness prompts with the base model while the per-model options in
    // the shared provider config carry the variant's routing preference.
    expect(model).toBe('openrouter/z-ai/glm-5.2');
    expect(config.model).toBe('openrouter/z-ai/glm-5.2');
    expect(config.provider?.openrouter?.models).toEqual({
      'z-ai/glm-5.2': { options: { provider: { sort: 'throughput' } } },
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    expect(baseConfig.provider?.openrouter?.models).toEqual({
      'z-ai/glm-5.2': { options: { provider: { sort: 'throughput' } } },
    });
  });

  it('lets a variant task model override win over a conflicting deployment variant', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv, model } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        HOME: homeDir,
        R_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      model: 'openrouter/z-ai/glm-5.2:free',
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      model?: string;
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    // Both variants collapse onto the same base-model entry; the per-task
    // override was the user's explicit choice for this run, so its variant
    // wins over the deployment default instead of failing the task.
    expect(model).toBe('openrouter/z-ai/glm-5.2');
    expect(config.model).toBe('openrouter/z-ai/glm-5.2');
    expect(config.provider?.openrouter?.models).toEqual({
      'z-ai/glm-5.2': { id: 'z-ai/glm-5.2:free' },
    });
  });

  it('applies the code review reasoning level when the task model override is the code review model', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_CODE_REVIEW_MODEL: 'test-provider/review-model',
        R_MODEL_REASONING_EFFORT: 'medium',
        R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'xhigh',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
      model: 'test-provider/review-model',
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      provider?: Record<string, { models?: Record<string, unknown> }>;
    };

    expect(baseConfig.provider?.['test-provider']?.models).toEqual({
      'review-model': { options: { reasoningEffort: 'xhigh' } },
      'main-model': { options: { reasoningEffort: 'medium' } },
    });
    expect(runtimeEnv).not.toHaveProperty('R_CODE_REVIEW_MODEL');
  });

  it('does not add a visual subagent when the vision model matches the coding model', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/main-model',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const visualModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-visual-model-instructions.md',
    );

    expect(baseConfig.agent).toEqual({
      judge: expect.objectContaining({ model: 'test-provider/main-model' }),
      advisor: expect.objectContaining({ model: 'test-provider/main-model' }),
      architect: expect.objectContaining({ mode: 'primary' }),
      general: { tools: slackPostingToolExclusions },
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.instructions).toEqual([
      path.join(
        homeDir,
        '.config',
        'opencode',
        'roomote-opencode-judge-model-instructions.md',
      ),
      path.join(
        homeDir,
        '.config',
        'opencode',
        'roomote-opencode-advisor-model-instructions.md',
      ),
    ]);
    expect(fs.existsSync(visualModelInstructionsPath)).toBe(false);
    expect(runtimeEnv).not.toHaveProperty('R_VISION_MODEL');
  });

  it('does not add a visual subagent when the vision model matches a task model override', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/override-model',
      },
      workspacePath: '/tmp/workspace',
      model: 'test-provider/override-model',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      model?: string;
    };

    expect(baseConfig.agent).toEqual({
      judge: expect.objectContaining({ model: 'test-provider/override-model' }),
      advisor: expect.objectContaining({
        model: 'test-provider/override-model',
      }),
      architect: expect.objectContaining({ mode: 'primary' }),
      general: { tools: slackPostingToolExclusions },
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.model).toBe('test-provider/override-model');
    expect(runtimeEnv).not.toHaveProperty('R_VISION_MODEL');
  });

  it('overrides the built-in explore agent when an explore model is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_EXPLORE_MODEL: 'openrouter/anthropic/claude-haiku-4',
        R_EXPLORE_MODEL_REASONING_EFFORT: 'high',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };

    expect(baseConfig.agent?.explore).toEqual({
      model: 'openrouter/anthropic/claude-haiku-4',
      options: { reasoning: { effort: 'high' } },
      tools: slackPostingToolExclusions,
    });
    expect(runtimeEnv).not.toHaveProperty('R_EXPLORE_MODEL');
    expect(runtimeEnv).not.toHaveProperty('R_EXPLORE_MODEL_REASONING_EFFORT');
  });

  it('configures a visual subagent when the vision model differs from a task model override', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/main-model',
      },
      workspacePath: '/tmp/workspace',
      model: 'test-provider/override-model',
      logger: createLogger(),
    });

    const baseConfig = JSON.parse(readOpenCodeConfig(homeDir)) as {
      agent?: Record<string, unknown>;
    };
    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      model?: string;
    };

    expect(baseConfig.agent?.visual).toMatchObject({
      mode: 'subagent',
      model: 'test-provider/main-model',
    });
    expect(config.agent).toEqual(baseConfig.agent);
    expect(config.model).toBe('test-provider/override-model');
    expect(runtimeEnv).not.toHaveProperty('R_VISION_MODEL');
  });

  it('configures a hidden proof-runner subagent when a proof browser target is provided', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        ROOMOTE_PROOF_BROWSER_TARGET: 'http://localhost:3000/',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const proofRunnerInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-proof-runner-instructions.md',
    );
    const judgeModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-judge-model-instructions.md',
    );
    const advisorModelInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-advisor-model-instructions.md',
    );
    const proofRunnerAgent = config.agent?.['proof-runner'] as {
      prompt?: string;
    };

    expect(config.agent?.['proof-runner']).toMatchObject({
      description: expect.stringContaining('proof'),
      mode: 'subagent',
      hidden: true,
      permission: {
        bash: 'allow',
        read: 'allow',
        edit: 'deny',
        task: 'deny',
        skill: 'allow',
      },
      tools: {
        ...slackPostingToolExclusions,
        roomote_manage_source_control: false,
        roomote_manage_tasks: false,
        roomote_manage_environments: false,
      },
    });
    const proofRunnerTools = (
      config.agent?.['proof-runner'] as { tools?: Record<string, boolean> }
    ).tools;
    expect(proofRunnerTools).not.toHaveProperty('roomote_manage_artifacts');
    expect(Object.values(proofRunnerTools ?? {})).not.toContain(true);
    expect(proofRunnerAgent.prompt).toContain(
      'Browser target: http://localhost:3000/',
    );
    expect(proofRunnerAgent.prompt).toContain('manage_artifacts');
    expect(proofRunnerAgent.prompt).toContain('agent-browser');
    expect(proofRunnerAgent.prompt).toContain(
      'explicitly load the `agent-browser` skill',
    );
    expect(proofRunnerAgent.prompt).toContain(
      'agent-browser skills get core --full',
    );
    expect(proofRunnerAgent.prompt).toContain(
      'not an OpenCode tool or MCP tool',
    );
    expect(config.instructions).toEqual([
      judgeModelInstructionsPath,
      advisorModelInstructionsPath,
      proofRunnerInstructionsPath,
    ]);
    expect(fs.readFileSync(proofRunnerInstructionsPath, 'utf8')).toContain(
      'proof-runner',
    );
    expect(fs.readFileSync(proofRunnerInstructionsPath, 'utf8')).toContain(
      'http://localhost:3000/',
    );
    expect(runtimeEnv).not.toHaveProperty('ROOMOTE_PROOF_BROWSER_TARGET');
  });

  it('does not add a proof-runner subagent when no proof browser target is provided', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };
    const proofRunnerInstructionsPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'roomote-opencode-proof-runner-instructions.md',
    );

    expect(config.agent).toEqual({
      judge: expect.objectContaining({ model: 'test-provider/main-model' }),
      advisor: expect.objectContaining({ model: 'test-provider/main-model' }),
      architect: expect.objectContaining({ mode: 'primary' }),
      general: { tools: slackPostingToolExclusions },
    });
    expect(config.instructions).toEqual([
      path.join(
        homeDir,
        '.config',
        'opencode',
        'roomote-opencode-judge-model-instructions.md',
      ),
      path.join(
        homeDir,
        '.config',
        'opencode',
        'roomote-opencode-advisor-model-instructions.md',
      ),
    ]);
    expect(fs.existsSync(proofRunnerInstructionsPath)).toBe(false);
    expect(runtimeEnv).not.toHaveProperty('ROOMOTE_PROOF_BROWSER_TARGET');
  });

  it('registers both the visual and proof-runner subagents together', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/vision-model',
        ROOMOTE_PROOF_BROWSER_TARGET: 'http://localhost:3000/',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, unknown>;
      instructions?: string[];
    };

    expect(config.agent?.visual).toMatchObject({ mode: 'subagent' });
    expect(config.agent?.judge).toMatchObject({ mode: 'subagent' });
    expect(config.agent?.advisor).toMatchObject({ mode: 'subagent' });
    expect(config.agent?.['proof-runner']).toMatchObject({
      mode: 'subagent',
    });
    expect(config.instructions).toHaveLength(4);
  });

  it('excludes the Slack-posting tools from every generated subagent and the built-in general agent', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        R_VISION_MODEL: 'test-provider/vision-model',
        R_EXPLORE_MODEL: 'test-provider/explore-model',
        ROOMOTE_PROOF_BROWSER_TARGET: 'http://localhost:3000/',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      agent?: Record<string, { tools?: Record<string, boolean> }>;
    };

    for (const agentName of [
      'visual',
      'judge',
      'advisor',
      'explore',
      'proof-runner',
      'general',
    ]) {
      expect(config.agent?.[agentName]?.tools, agentName).toMatchObject(
        slackPostingToolExclusions,
      );
    }

    // The built-in general agent override only strips the Slack-posting
    // tools; anything more would change the default background subagent.
    expect(config.agent?.general).toEqual({
      tools: slackPostingToolExclusions,
    });

    // The architect agent is a primary (parent-session) agent for plan-mode
    // turns and must keep its Slack-posting tools.
    expect(config.agent?.architect?.tools).toBeUndefined();
  });

  it('rejects invalid vision model IDs', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    expect(
      await prepareOpenCodeCommandEnv({
        runtimeEnv: {
          ...createDirectHarnessRuntimeEnv(homeDir),
          R_VISION_MODEL: 'vision-model-without-provider',
        },
        workspacePath: '/tmp/workspace',
        logger: createLogger(),
      }).catch((error: unknown) => {
        expect(String(error)).toMatch(
          /R_VISION_MODEL must use provider\/model format/u,
        );
        return null;
      }),
    ).toBeNull();
  });

  it('passes the worker Node executable to OpenCode Slack hook plugins', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const pluginContent = readOpenCodeSlackPlugin(homeDir);

    expect(runtimeEnv.ROOMOTE_NODE_EXECUTABLE).toBe(process.execPath);
    expect(pluginContent).toContain('ROOMOTE_NODE_EXECUTABLE');
    expect(pluginContent).toContain("|| 'node'");
    expect(pluginContent).not.toContain('spawnSync(process.execPath');
    expect(
      fs.existsSync(
        path.join(
          homeDir,
          '.config',
          'opencode',
          'plugins',
          'roomote-slack-hooks.mjs',
        ),
      ),
    ).toBe(false);
  });

  it('enables Slack hook debug logs only when Slack reply satisfaction is configured', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const withoutSlackHomeDir = createTempHome();
    const withSlackHomeDir = createTempHome();
    const explicitDebugHomeDir = createTempHome();

    const { commandEnv: withoutSlackEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(withoutSlackHomeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });
    const { commandEnv: withSlackEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(withSlackHomeDir),
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
          '/tmp/roomote-slack-state.json',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });
    const { commandEnv: explicitDebugEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(explicitDebugHomeDir),
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
          '/tmp/roomote-slack-state.json',
        ROOMOTE_SLACK_HOOK_DEBUG: 'false',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    expect(withoutSlackEnv).not.toHaveProperty('ROOMOTE_SLACK_HOOK_DEBUG');
    expect(withSlackEnv.ROOMOTE_SLACK_HOOK_DEBUG).toBe('1');
    expect(explicitDebugEnv.ROOMOTE_SLACK_HOOK_DEBUG).toBe('false');
  });

  it('sets OpenRouter attribution headers on the generated provider config', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv: runtimeEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: createDirectHarnessRuntimeEnv(homeDir),
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const config = readRoomoteOpenCodeOverlay(runtimeEnv) as {
      provider?: Record<string, unknown>;
    };

    expect(config.provider?.openrouter).toMatchObject({
      options: {
        headers: {
          'HTTP-Referer': 'https://roomote.dev',
          'X-Title': 'Roomote',
        },
      },
    });
  });

  it('materializes OPENCODE_AUTH_CONTENT into auth.json and strips the env var', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const authContent = JSON.stringify({
      openai: { type: 'oauth', refresh: 'rt', access: 'at', expires: 123 },
    });

    const { commandEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        OPENCODE_AUTH_CONTENT: authContent,
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    expect(commandEnv.OPENCODE_AUTH_CONTENT).toBeUndefined();
    const authPath = path.join(
      homeDir,
      '.local',
      'share',
      'opencode',
      'auth.json',
    );
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.readFileSync(authPath, 'utf8')).toBe(authContent);
  });

  it('leaves OPENCODE_AUTH_CONTENT set when auth.json cannot be written', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    // Point HOME at a path that cannot be created (a file under an existing
    // file) so the mkdir for the opencode data dir fails.
    const homeDir = createTempHome();
    fs.writeFileSync(path.join(homeDir, '.local'), 'block');

    const authContent = JSON.stringify({ openai: { type: 'oauth' } });

    const { commandEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        OPENCODE_AUTH_CONTENT: authContent,
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    // Failed materialization keeps the env var as a fallback.
    expect(commandEnv.OPENCODE_AUTH_CONTENT).toBe(authContent);
  });

  it('materializes inline GOOGLE_APPLICATION_CREDENTIALS JSON to a file path', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
    });

    const { commandEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    const credentialsPath = path.join(
      homeDir,
      '.local',
      'share',
      'opencode',
      'google-application-credentials.json',
    );
    expect(commandEnv.GOOGLE_APPLICATION_CREDENTIALS).toBe(credentialsPath);
    expect(fs.readFileSync(credentialsPath, 'utf8')).toBe(credentialsJson);
  });

  it('leaves a GOOGLE_APPLICATION_CREDENTIALS file path untouched', async () => {
    const { prepareOpenCodeCommandEnv } =
      await import('../opencode-server/bootstrap');

    const homeDir = createTempHome();

    const { commandEnv } = await prepareOpenCodeCommandEnv({
      runtimeEnv: {
        ...createDirectHarnessRuntimeEnv(homeDir),
        GOOGLE_APPLICATION_CREDENTIALS: '/etc/roomote/service-account.json',
      },
      workspacePath: '/tmp/workspace',
      logger: createLogger(),
    });

    expect(commandEnv.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      '/etc/roomote/service-account.json',
    );
  });
});
