import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOpenCodeCliEnv,
  killOpenCodeSdkServerProcessesForShutdown,
  leaseOpenCodeSdkServer,
} from '../opencode-runtime';

describe('buildOpenCodeCliEnv', () => {
  const managedKeys = [
    'OPENCODE_CONFIG_CONTENT',
    'ROOMOTE_MODEL',
    'ROOMOTE_SMALL_MODEL',
    'ROOMOTE_MODEL_REASONING_EFFORT',
    'ROOMOTE_SMALL_MODEL_REASONING_EFFORT',
    'GOOGLE_APPLICATION_CREDENTIALS',
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
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
    });
  });

  it('applies per-role reasoning options to the model-backed config', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_SMALL_MODEL: 'openrouter/z-ai/glm-5.2',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
      ROOMOTE_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
        openrouter: {
          models: {
            'openai/gpt-5.4': {
              options: { reasoning: { effort: 'high' } },
            },
            'z-ai/glm-5.2': {
              options: { reasoning: { effort: 'low' } },
            },
          },
        },
      },
    });
  });

  it('rewrites OpenRouter variant models to catalog base models with per-model options', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': {
              options: {
                reasoning: { effort: 'high' },
                provider: { sort: 'throughput' },
              },
            },
          },
        },
      },
    });
  });

  it('lets the coding model variant win when roles disagree on a shared base model', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      ROOMOTE_SMALL_MODEL: 'openrouter/z-ai/glm-5.2:free',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': { options: { provider: { sort: 'throughput' } } },
          },
        },
      },
    });
  });

  it('lets the coding model reasoning level win when both roles share a model', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
      ROOMOTE_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
      provider: {
        openrouter: {
          models: {
            'openai/gpt-5.4': {
              options: { reasoning: { effort: 'high' } },
            },
          },
        },
      },
    });
  });

  it('materializes inline GOOGLE_APPLICATION_CREDENTIALS JSON to a temp file path', () => {
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
    });

    const env = buildOpenCodeCliEnv({
      GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
    });

    const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
    expect(credentialsPath).toBeDefined();
    expect(credentialsPath).not.toBe(credentialsJson);
    expect(readFileSync(credentialsPath!, 'utf8')).toBe(credentialsJson);
  });

  it('leaves a GOOGLE_APPLICATION_CREDENTIALS file path untouched', () => {
    const env = buildOpenCodeCliEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/roomote/service-account.json',
    });

    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      '/etc/roomote/service-account.json',
    );
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
