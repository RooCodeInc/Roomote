import * as readline from 'node:readline';
import net from 'node:net';

import { execa, type ResultPromise } from 'execa';

import type { HarnessLogger } from '../../../../logging';

import { createPrefixedLogger, describeUnknownError } from '../logging';

import { prepareOpenCodeCommandEnv } from './bootstrap';
import { OpenCodeServerClient } from './client';
import {
  createOpenCodeExitCertificateCollector,
  type OpenCodeExitCertificate,
} from './exit-certificate';
import { isExpectedSubprocessExit } from './expected-exit';
import { OpenCodeServerHarness } from './harness';

interface StartOpenCodeServerHarnessOptions {
  workspacePath: string;
  runtimeEnv: Record<string, string>;
  cancelSignal: AbortSignal;
  logger: HarnessLogger;
  mcpServers: Record<string, unknown>;
  initialSessionId?: string;
  modelOverride?: string;
  developerInstructionsContent?: string;
  /**
   * Invoked when the OpenCode server subprocess exits while the task was not
   * being cancelled — the death certificate for post-mortems. Observer-only:
   * failures inside the callback must not affect the harness lifecycle.
   */
  onUnexpectedExit?: (certificate: OpenCodeExitCertificate) => void;
  beforeQueuedPrompt?: (input: { userId?: string }) => Promise<void | {
    shouldReconnect: boolean;
    shouldBlockPrompt?: boolean;
    shouldSkipPrompt?: boolean;
    reason?: string;
  }>;
}

interface StartOpenCodeServerHarnessResult {
  harness: OpenCodeServerHarness;
  subprocess: ResultPromise;
}

function shellEscape(value: string): string {
  const escapedSingleQuote = `'"'"'`;
  return `'${value.replace(/'/g, escapedSingleQuote)}'`;
}

function resolveOpenCodeCommand(args: string[]): {
  command: string;
  args: string[];
} {
  const configured = process.env.OPENCODE_COMMAND?.trim();

  if (!configured) {
    return { command: 'opencode', args };
  }

  return {
    command: 'bash',
    args: ['-lc', `${configured} ${args.map(shellEscape).join(' ')}`],
  };
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseOpenCodeServerUrl(line: string): string | null {
  const match = /opencode server listening on\s+(http:\/\/\S+)/iu.exec(
    line.trim(),
  );

  return match?.[1] ?? null;
}

async function getAvailableLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to resolve OpenCode server port.'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function waitForOpenCodeServerUrl(options: {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  logger: HarnessLogger;
  timeoutMs: number;
}): Promise<string> {
  const log = createPrefixedLogger(options.logger, '[opencode-server]');
  const stdoutLog = createPrefixedLogger(
    options.logger,
    '[opencode-server:stdout]',
  );
  const stderrLog = createPrefixedLogger(
    options.logger,
    '[opencode-server:stderr]',
  );

  return new Promise<string>((resolve, reject) => {
    let resolved = false;
    const stdoutReader = readline.createInterface({
      input: options.stdout,
      crlfDelay: Infinity,
    });
    const stderrReader = readline.createInterface({
      input: options.stderr,
      crlfDelay: Infinity,
    });

    const timer = setTimeout(() => {
      if (resolved) {
        return;
      }

      cleanup();
      reject(new Error('Timed out waiting for OpenCode server URL.'));
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      stdoutReader.off('line', handleStdoutLine);
      stderrReader.off('line', handleStderrLine);
    };

    const maybeResolve = (source: 'stdout' | 'stderr', line: string) => {
      if (resolved) {
        return;
      }

      const url = parseOpenCodeServerUrl(line);

      if (!url) {
        return;
      }

      resolved = true;
      clearTimeout(timer);
      log.info(`Detected OpenCode server URL on ${source}: ${url}`);
      resolve(url);
    };

    const handleStdoutLine = (line: string) => {
      if (line.trim().length > 0) {
        stdoutLog.info(line);
      }

      maybeResolve('stdout', line);
    };

    const handleStderrLine = (line: string) => {
      if (line.trim().length > 0) {
        stderrLog.info(line);
      }

      maybeResolve('stderr', line);
    };

    stdoutReader.on('line', handleStdoutLine);
    stderrReader.on('line', handleStderrLine);
  });
}

export async function startOpenCodeServerHarness({
  workspacePath,
  runtimeEnv,
  cancelSignal,
  logger,
  mcpServers,
  initialSessionId,
  modelOverride,
  developerInstructionsContent,
  onUnexpectedExit,
  beforeQueuedPrompt,
}: StartOpenCodeServerHarnessOptions): Promise<StartOpenCodeServerHarnessResult> {
  const log = createPrefixedLogger(logger, '[opencode-server]');
  const port = await getAvailableLocalPort();
  const { commandEnv, model } = await prepareOpenCodeCommandEnv({
    runtimeEnv,
    workspacePath,
    mcpServers,
    model: modelOverride,
    developerInstructionsContent,
    logger,
  });
  const resolved = resolveOpenCodeCommand([
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
    '--print-logs',
    '--log-level',
    'INFO',
  ]);

  log.info(
    `Launching OpenCode server command=${resolved.command} args=${JSON.stringify(
      resolved.args,
    )} cwd=${workspacePath} model=${model ?? 'roomote-model-default'}`,
  );

  let subprocess: ResultPromise | null = null;
  const exitCertificate = createOpenCodeExitCertificateCollector();

  try {
    subprocess = execa(resolved.command, resolved.args, {
      cwd: workspacePath,
      env: commandEnv,
      extendEnv: false,
      cancelSignal,
    });
    void subprocess.catch(() => {});

    if (!subprocess.stdout || !subprocess.stderr) {
      throw new Error(
        'OpenCode server subprocess is missing stdout or stderr.',
      );
    }

    if (onUnexpectedExit) {
      // The certificate needs the process's last words, not its first: these
      // readers stay attached for the whole subprocess lifetime, independent
      // of the startup URL wait and its listener lifecycle.
      const stdoutTailReader = readline.createInterface({
        input: subprocess.stdout,
        crlfDelay: Infinity,
      });
      const stderrTailReader = readline.createInterface({
        input: subprocess.stderr,
        crlfDelay: Infinity,
      });
      stdoutTailReader.on('line', (line) =>
        exitCertificate.appendLine('stdout', line),
      );
      stderrTailReader.on('line', (line) =>
        exitCertificate.appendLine('stderr', line),
      );

      const spawnedSubprocess = subprocess;
      const certifyExit = (input: {
        exitCode: number | null;
        signal: string | null;
      }) => {
        if (
          cancelSignal.aborted ||
          isExpectedSubprocessExit(spawnedSubprocess)
        ) {
          return;
        }

        try {
          onUnexpectedExit(exitCertificate.build(input));
        } catch (error) {
          log.warn(
            `Failed to report unexpected OpenCode server exit: ${describeUnknownError(error)}`,
          );
        }
      };

      void subprocess.then(
        (result) =>
          certifyExit({
            exitCode: result.exitCode ?? null,
            signal: result.signal ?? null,
          }),
        (error: unknown) => {
          const execaError = error as {
            exitCode?: number;
            signal?: string;
            isCanceled?: boolean;
          };

          if (execaError?.isCanceled) {
            return;
          }

          certifyExit({
            exitCode: execaError?.exitCode ?? null,
            signal: execaError?.signal ?? null,
          });
        },
      );
    }

    cancelSignal.addEventListener(
      'abort',
      () => {
        log.info('Abort received; sending SIGTERM');
        subprocess?.kill('SIGTERM');
      },
      { once: true },
    );

    const baseUrl = await Promise.race([
      waitForOpenCodeServerUrl({
        stdout: subprocess.stdout,
        stderr: subprocess.stderr,
        logger,
        timeoutMs: 30_000,
      }),
      subprocess.then(
        () => {
          throw new Error(
            'OpenCode server exited before printing a listening URL.',
          );
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    const client = new OpenCodeServerClient({
      baseUrl,
      workspacePath,
      logger,
    });
    const harness = new OpenCodeServerHarness({
      client,
      workspacePath,
      logger: log,
      commandEnv,
      initialSessionId,
      model,
      stopHookReminderStallTimeoutMs: parseTimeoutMs(
        process.env.ROOMOTE_STOP_HOOK_REMINDER_STALL_TIMEOUT_MS,
      ),
      steerPickupTimeoutMs: parseTimeoutMs(
        process.env.ROOMOTE_OPENCODE_STEER_PICKUP_TIMEOUT_MS,
      ),
      turnStallTimeoutMs: parseTimeoutMs(
        process.env.ROOMOTE_OPENCODE_TURN_STALL_TIMEOUT_MS,
      ),
      subagentSettlementGraceMs: parseTimeoutMs(
        process.env.ROOMOTE_SUBAGENT_SETTLEMENT_GRACE_MS,
      ),
      mcpServerNames: Object.keys(mcpServers),
      beforeQueuedPrompt,
    });

    await harness.connect();

    log.info(
      `OpenCode server harness connected baseUrl=${baseUrl} sessionId=${
        initialSessionId ?? 'none'
      }`,
    );

    return { harness, subprocess };
  } catch (error) {
    log.error(
      `Failed to start OpenCode server: ${describeUnknownError(error)}`,
    );
    subprocess?.kill('SIGTERM');
    throw error;
  }
}
