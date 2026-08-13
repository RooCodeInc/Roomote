import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOpenCodeCliEnv,
  killOpenCodeSdkServerProcessesForShutdown,
  leaseOpenCodeSdkServer,
  NON_TASK_TOOL_PERMISSION_DENIALS,
  readOpenCodeDebugConfig,
} from '../opencode-runtime';

describe('buildOpenCodeCliEnv', () => {
  const managedKeys = [
    'OPENCODE_CONFIG_CONTENT',
    'R_MODEL',
    'R_SMALL_MODEL',
    'R_VISION_MODEL',
    'R_MODEL_REASONING_EFFORT',
    'R_SMALL_MODEL_REASONING_EFFORT',
    'R_VISION_MODEL_REASONING_EFFORT',
    'R_CHATGPT_FAST_MODE',
    'LITELLM_BASE_URL',
    'LITELLM_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'MISTRAL_API_KEY',
    'BASH_ENV',
    'OPENCODE_COMMAND',
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of managedKeys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of managedKeys) {
      const original = originalValues.get(key);

      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it('builds a model-backed config without reasoning options by default', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/openai/gpt-5.4',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('materializes LiteLLM provider config for restricted helper inference', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'litellm/qwen3.6:35b-unsloth',
      R_SMALL_MODEL: 'litellm/coding',
      LITELLM_BASE_URL: 'https://litellm.example.com/v1',
      LITELLM_API_KEY: 'secret',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'litellm/qwen3.6:35b-unsloth',
      small_model: 'litellm/coding',
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: {
            baseURL: 'https://litellm.example.com/v1',
            apiKey: '{env:LITELLM_API_KEY}',
          },
          models: {
            'qwen3.6:35b-unsloth': { name: 'qwen3.6:35b-unsloth' },
            coding: { name: 'coding' },
          },
        },
      },
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('registers a distinct vision model with its configured provider', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'openrouter/google/gemini-3.6-flash',
      R_VISION_MODEL: 'litellm/gemini-3.6-pro',
      LITELLM_BASE_URL: 'https://litellm.example.com/v1',
      LITELLM_API_KEY: 'secret',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.6-terra',
      small_model: 'openrouter/google/gemini-3.6-flash',
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: {
            baseURL: 'https://litellm.example.com/v1',
            apiKey: '{env:LITELLM_API_KEY}',
          },
          models: {
            'gemini-3.6-pro': {
              name: 'gemini-3.6-pro',
              attachment: true,
              modalities: {
                input: ['text', 'image', 'video'],
                output: ['text'],
              },
            },
          },
        },
      },
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('does not infer model ownership from LiteLLM endpoint availability', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'qwen3.6:35b-unsloth',
      LITELLM_BASE_URL: 'https://litellm.example.com/v1',
      LITELLM_API_KEY: 'secret',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'qwen3.6:35b-unsloth',
      small_model: 'qwen3.6:35b-unsloth',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('strips per-role reasoning options from the restricted helper config', () => {
    // Non-task structured output forces tool choice, which Amazon Bedrock
    // rejects when thinking is enabled — so helper servers run without the
    // operator's coding-harness reasoning levels on every provider.
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/z-ai/glm-5.2',
      R_MODEL_REASONING_EFFORT: 'high',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/z-ai/glm-5.2',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('strips Bedrock thinking config while keeping the model selection', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'amazon-bedrock/anthropic.claude-sonnet-5-v1:0',
      R_SMALL_MODEL: 'amazon-bedrock/anthropic.claude-haiku-4-5-v1:0',
      R_SMALL_MODEL_REASONING_EFFORT: 'medium',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'amazon-bedrock/anthropic.claude-sonnet-5-v1:0',
      small_model: 'amazon-bedrock/anthropic.claude-haiku-4-5-v1:0',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('strips thinking options from operator-supplied config content', () => {
    const env = buildOpenCodeCliEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'anthropic/claude-sonnet-5',
        provider: {
          anthropic: {
            models: {
              'claude-sonnet-5': {
                options: {
                  thinking: { type: 'adaptive' },
                  effort: 'high',
                },
              },
            },
          },
        },
      }),
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'anthropic/claude-sonnet-5',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('applies ChatGPT fast mode to supported subscription models', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'openai/gpt-5.6-luna',
      R_MODEL_REASONING_EFFORT: 'high',
      R_CHATGPT_FAST_MODE: '1',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openai/gpt-5.6-terra',
      small_model: 'openai/gpt-5.6-luna',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
      provider: {
        openai: {
          models: {
            'gpt-5.6-terra': {
              // reasoningEffort is stripped for helper servers; the fast-mode
              // service tier is not a reasoning option and survives.
              options: { serviceTier: 'priority' },
            },
            'gpt-5.6-luna': {
              options: { serviceTier: 'priority' },
            },
          },
        },
      },
    });
  });

  it('rewrites OpenRouter variant models to catalog base models with per-model options', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      R_MODEL_REASONING_EFFORT: 'high',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': {
              // The variant's routing options survive; the reasoning option
              // is stripped for helper servers.
              options: { provider: { sort: 'throughput' } },
            },
          },
        },
      },
    });
  });

  it('lets the coding model variant win when roles disagree on a shared base model', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      R_SMALL_MODEL: 'openrouter/z-ai/glm-5.2:free',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': { options: { provider: { sort: 'throughput' } } },
          },
        },
      },
    });
  });

  it('prunes the provider subtree when reasoning was its only content', () => {
    // Role precedence for shared models is covered by the
    // mergeOpenCodeModelReasoningOptions tests in @roomote/types; here the
    // merged reasoning is stripped again for helper servers, so nothing of
    // the provider subtree remains.
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
      R_MODEL_REASONING_EFFORT: 'high',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('strips disabled-provider credentials', () => {
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
    });

    const env = buildOpenCodeCliEnv({
      GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
      MISTRAL_API_KEY: 'mistral-key',
    });

    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
  });

  it('strips disabled model role overrides', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: 'google-vertex/gemini-3.5-flash',
      R_SMALL_MODEL: 'mistral/mistral-large-latest',
      MISTRAL_API_KEY: 'mistral-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/roomote/service-account.json',
    });

    expect(env.R_MODEL).toBeUndefined();
    expect(env.R_SMALL_MODEL).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    // No model-backed config remains, but the tool lockdown still applies.
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('denies tools without any model config', () => {
    const env = buildOpenCodeCliEnv();

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('keeps model and provider config from operator-supplied content', () => {
    const env = buildOpenCodeCliEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'openrouter/openai/gpt-5.4',
        provider: { openrouter: { options: { baseURL: 'https://example' } } },
        // An operator-supplied allow must not survive: these servers only
        // serve non-task calls, which never run tools.
        permission: 'allow',
      }),
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      provider: { openrouter: { options: { baseURL: 'https://example' } } },
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('strips config keys that can introduce or re-enable tools', () => {
    const env = buildOpenCodeCliEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'openrouter/openai/gpt-5.4',
        // Each of these can add tools outside the enumerated denial list
        // (or re-enable built-ins), so none may reach a helper server.
        mcp: { docs: { type: 'remote', url: 'https://example/mcp' } },
        plugin: ['some-plugin'],
        agent: { build: { tools: { bash: true } } },
        mode: { build: { tools: { edit: true } } },
        tools: { bash: true },
        default_agent: 'build',
        // Operator permission entries never survive, including entries for
        // tools we do not enumerate.
        permission: { docs_search: 'allow', bash: 'allow' },
      }),
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('never uses a blanket permission denial', () => {
    // Regression guard: OpenCode fulfils `format: json_schema` structured
    // output through an internal mechanism that a blanket "deny" (or a
    // wildcard rule) strips, silently breaking every structured routing
    // call. The denial must stay in enumerated object form.
    expect(typeof NON_TASK_TOOL_PERMISSION_DENIALS).toBe('object');
    expect(Object.keys(NON_TASK_TOOL_PERMISSION_DENIALS)).not.toContain('*');
    expect(Object.values(NON_TASK_TOOL_PERMISSION_DENIALS)).toEqual(
      Object.keys(NON_TASK_TOOL_PERMISSION_DENIALS).map(() => 'deny'),
    );
  });

  it('fails closed to a permission-only config on malformed content', () => {
    for (const malformed of ['{not json', '"just a string"', '[1,2]']) {
      const env = buildOpenCodeCliEnv({
        OPENCODE_CONFIG_CONTENT: malformed,
      });

      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
        permission: NON_TASK_TOOL_PERMISSION_DENIALS,
      });
    }
  });

  it('prevents inherited BASH_ENV from restoring disabled credentials through a shell wrapper', () => {
    const fixtureDir = mkdtempSync(
      path.join(tmpdir(), 'opencode-bash-env-test-'),
    );
    const bashEnvPath = path.join(fixtureDir, 'shared-env.sh');
    const commandPath = path.join(fixtureDir, 'print-env.cjs');

    writeFileSync(
      bashEnvPath,
      [
        "export GOOGLE_APPLICATION_CREDENTIALS='/stale/vertex.json'",
        "export MISTRAL_API_KEY='stale-mistral-key'",
      ].join('\n'),
    );
    writeFileSync(
      commandPath,
      `process.stdout.write(JSON.stringify({
        googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        mistralApiKey: process.env.MISTRAL_API_KEY,
      }));`,
    );

    process.env.BASH_ENV = bashEnvPath;
    process.env.OPENCODE_COMMAND = `${process.execPath} ${commandPath}`;

    try {
      expect(JSON.parse(readOpenCodeDebugConfig())).toEqual({});
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// Fake `opencode serve`: answers the readiness probe on the requested port,
// spawns a grandchild, and records both pids so the test can verify the
// whole process tree dies on shutdown.
const FIXTURE_SERVER_SOURCE = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = Number(portArg.split('=')[1]);
const grandchild = spawn('sleep', ['300']);

createServer((req, res) => {
  res.statusCode = 200;
  res.end('ok');
}).listen(port, '127.0.0.1', () => {
  writeFileSync(
    process.env.OPENCODE_FIXTURE_PID_FILE,
    JSON.stringify({ serverPid: process.pid, grandchildPid: grandchild.pid }),
  );
});
`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return condition();
}

describe('OpenCode SDK server shutdown', () => {
  const originalOpencodeCommand = process.env.OPENCODE_COMMAND;
  let fixtureDir: string;
  let trackedPids: number[] = [];

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'opencode-runtime-test-'));
    trackedPids = [];
  });

  afterEach(() => {
    if (originalOpencodeCommand === undefined) {
      delete process.env.OPENCODE_COMMAND;
    } else {
      process.env.OPENCODE_COMMAND = originalOpencodeCommand;
    }

    for (const pid of trackedPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead — the expected case.
        }
      }
    }

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('kills the whole server process tree, including shell-wrapped grandchildren', async () => {
    const fixturePath = path.join(fixtureDir, 'fixture-server.cjs');
    const pidFilePath = path.join(fixtureDir, 'pids.json');
    writeFileSync(fixturePath, FIXTURE_SERVER_SOURCE);

    // A command with whitespace routes the spawn through `bash -lc`, so the
    // managed proc is the shell and the real server is a grandchild — the
    // shape that leaked before group signaling.
    process.env.OPENCODE_COMMAND = `${process.execPath} ${fixturePath}`;

    const lease = await leaseOpenCodeSdkServer({
      env: { OPENCODE_FIXTURE_PID_FILE: pidFilePath },
      startTimeoutMs: 15_000,
    });

    try {
      const pidFileWritten = await waitFor(() => {
        try {
          readFileSync(pidFilePath, 'utf8');
          return true;
        } catch {
          return false;
        }
      }, 5_000);
      expect(pidFileWritten).toBe(true);

      const { serverPid, grandchildPid } = JSON.parse(
        readFileSync(pidFilePath, 'utf8'),
      ) as { serverPid: number; grandchildPid: number };
      trackedPids = [serverPid, grandchildPid];

      expect(isProcessAlive(serverPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      killOpenCodeSdkServerProcessesForShutdown();

      expect(
        await waitFor(
          () => !isProcessAlive(serverPid) && !isProcessAlive(grandchildPid),
          5_000,
        ),
      ).toBe(true);
    } finally {
      lease.release();
    }
  });

  it('registers terminating-signal handlers once a server is leased', () => {
    // Leased in the previous test via the shared pool; registration is
    // per-process, so the handlers must be present now.
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGHUP')).toBeGreaterThanOrEqual(1);
  });
});
