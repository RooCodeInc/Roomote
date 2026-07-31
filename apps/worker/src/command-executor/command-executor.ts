import { createHash, randomBytes } from 'crypto';
import { appendFileSync, readFileSync } from 'fs';
import { basename, join, relative } from 'path';

import { execa, ExecaError } from 'execa';

import { COMMAND_RETRY_DELAY_MS, type Command } from '@roomote/types';

import { substituteEnvVars } from '../env';

interface ExecuteOptions {
  verbose?: boolean;
}

interface ExecuteAllOptions {
  verbose?: boolean;
  onStart?: (command: Command) => void;
  onResult?: (result: ExecutionResult) => void;
  continueOnExecutionError?: boolean;
}

type DetachedProcessManager = 'shell' | 'pm2';

interface CommandExecutorOptions {
  detachedProcessManager?: DetachedProcessManager;
}

// Prefer the worker image's pinned PM2 symlink, but fall back to a PATH-based
// PM2 binary for non-image runtimes that install PM2 normally.
export const ROOMOTE_BUNDLED_PM2_BINARY_PATH = '/usr/local/bin/pm2';
export const ROOMOTE_PATH_PM2_BINARY = 'pm2';

export interface ExecutionResult {
  command: Command;
  success: boolean;
  duration: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  timedOut?: boolean;
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly result: ExecutionResult,
  ) {
    super(message);

    this.name = 'ExecutionError';
  }

  /**
   * Format the execution result into a human-readable diagnostic string.
   */
  formatDetails(): string {
    const { result } = this;

    const sanitize = (value: string) =>
      value.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
    const truncate = (s: string, max = 4000) => {
      const sanitized = sanitize(s);
      return sanitized.length > max
        ? '... (truncated)\n' + sanitized.slice(-max)
        : sanitized;
    };

    const parts = [sanitize(result.command.run)];

    if (result.exitCode !== undefined) {
      parts.push(`\nexit code -> ${result.exitCode}`);
    }

    if (result.timedOut) {
      parts.push(`\ntimeout -> ${result.command.timeout} seconds`);
    }

    if (result.error) {
      parts.push(`\nerror -> ${truncate(result.error)}`);
    }

    if (result.stdout) {
      parts.push(`\nstdout -> ${truncate(result.stdout)}`);
    }

    if (result.stderr) {
      parts.push(`\nstderr -> ${truncate(result.stderr)}`);
    }

    return parts.join('\n');
  }
}

export class CommandExecutor {
  private readonly detachedProcessManager: DetachedProcessManager;

  constructor(
    private readonly cwd: string,
    private readonly env: Record<string, string | undefined>,
    private readonly verbose: boolean = false,
    options: CommandExecutorOptions = {},
  ) {
    this.detachedProcessManager = options.detachedProcessManager ?? 'shell';
  }

  async execute(
    command: Command,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    const verbose = options.verbose ?? this.verbose;
    const startTime = Date.now();

    let success = true;
    let duration;
    let error;
    let exitCode: number | undefined;
    let timedOut = false;
    let stderr = '';
    let stdout = '';

    const workingDir = command.working_dir
      ? join(this.cwd, command.working_dir)
      : command.cwd
        ? command.cwd
        : this.cwd;

    const commandLines = joinContinuationLines(command.run)
      .filter((line) => line.length > 0)
      .filter((line) => !line.startsWith('#'));
    const retries = command.retries ?? 0;

    try {
      for (const [_index, cmdLine] of commandLines.entries()) {
        const tag = `[${basename(this.cwd)}]`;

        // Merge environment variables with priority: command.env > this.env.
        // No longer inherits from process.env - the caller is responsible for
        // providing the appropriate base env via the constructor.
        // Resolve $VAR / ${VAR} references in command-level env against the base env.
        const env = command.env
          ? {
              ...this.env,
              ...substituteEnvVars(
                command.env,
                Object.fromEntries(
                  Object.entries(this.env).filter(
                    (entry): entry is [string, string] =>
                      entry[1] !== undefined,
                  ),
                ),
              ),
            }
          : { ...this.env };

        // Handle detached commands - run in background without awaiting.
        const result = await this.executeCommandLineWithRetries({
          cmdLine,
          command,
          env,
          tag,
          verbose,
          workingDir,
          retries,
        });

        // Accumulate output from all commands.
        if (result.stdout) {
          if (verbose) {
            console.log(result.stdout);
          }

          stdout += (stdout ? '\n' : '') + result.stdout;
        }

        if (result.stderr) {
          if (verbose) {
            console.log(result.stderr);
          }

          stderr += (stderr ? '\n' : '') + result.stderr;
        }
      }

      duration = Date.now() - startTime;
    } catch (e) {
      success = false;
      duration = Date.now() - startTime;

      if (e instanceof ExecaError) {
        error = e.shortMessage;
        exitCode = e.exitCode;
        timedOut = e.timedOut;

        if (e.stdout) {
          if (verbose) {
            console.log(e.stdout);
          }

          stdout += (stdout ? '\n' : '') + e.stdout;
        }

        if (e.stderr) {
          if (verbose) {
            console.log(e.stderr);
          }

          stderr += (stderr ? '\n' : '') + e.stderr;
        }
      } else {
        error = e instanceof Error ? e.message : String(e);
      }

      console.error(`[${command.name}] ✗ Error: ${error} (${duration}ms)`);
    }

    const result = {
      command,
      success,
      duration,
      exitCode,
      stdout,
      stderr,
      error,
      timedOut,
    };

    if (!success && !command.continue_on_error) {
      const err = new ExecutionError(
        error ?? 'Unknown execution error',
        result,
      );

      console.error(`${command.name} failed:\n${err.formatDetails()}`);

      throw err;
    }

    return result;
  }

  async executeAll(
    commands: Command[],
    options: ExecuteAllOptions = {},
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    if (this.detachedProcessManager === 'pm2') {
      await cleanupStalePm2Processes({
        repoRoot: this.cwd,
        env: this.env,
        desiredProcessNames: new Set(
          this.listDetachedPm2ProcessNames(commands),
        ),
      });
    }

    for (const command of commands) {
      options.onStart?.(command);
      try {
        const result = await this.execute(command, options);
        results.push(result);
        options.onResult?.(result);
      } catch (error) {
        if (
          !options.continueOnExecutionError ||
          !(error instanceof ExecutionError)
        ) {
          throw error;
        }

        results.push(error.result);
        options.onResult?.(error.result);
      }
    }

    return results;
  }

  private async executeCommandLineWithRetries({
    cmdLine,
    command,
    env,
    tag,
    verbose,
    workingDir,
    retries,
  }: {
    cmdLine: string;
    command: Command;
    env: Record<string, string | undefined>;
    tag: string;
    verbose: boolean;
    workingDir: string;
    retries: number;
  }) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.executeCommandLine({
          cmdLine,
          command,
          env,
          tag,
          verbose,
          workingDir,
        });
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }

        const exitCodeInfo =
          error instanceof ExecaError && error.exitCode !== undefined
            ? ` Exit code: ${error.exitCode}.`
            : '';

        console.warn(
          `[${command.name}] Attempt ${attempt + 1}/${retries + 1} failed.${exitCodeInfo} Retrying in ${COMMAND_RETRY_DELAY_MS}ms...`,
        );

        await this.sleep(COMMAND_RETRY_DELAY_MS);
      }
    }

    throw new Error('Unreachable retry state');
  }

  private async executeCommandLine({
    cmdLine,
    command,
    env,
    tag,
    verbose,
    workingDir,
  }: {
    cmdLine: string;
    command: Command;
    env: Record<string, string | undefined>;
    tag: string;
    verbose: boolean;
    workingDir: string;
  }) {
    if (command.detached) {
      const logfile =
        command.logfile ??
        join(workingDir, `detached-${randomBytes(4).toString('hex')}.log`);

      if (verbose) {
        console.log(`${tag} Running in detached mode: ${cmdLine}`);
        console.log(`${tag} Logging to: ${logfile}`);
      }

      await startBackgroundProcess({
        cmdLine,
        cwd: workingDir,
        env,
        logfile,
        manager: this.detachedProcessManager,
        processName: buildPm2ProcessName({
          commandName: command.name,
          cmdLine,
          cwd: workingDir,
        }),
      });

      return { stdout: '', stderr: '' };
    }

    if (verbose) {
      console.log(`${tag} ${cmdLine}`);
    }

    return execa(cmdLine, {
      shell: '/bin/bash',
      cwd: workingDir,
      extendEnv: false,
      env,
      stdin: 'ignore',
      timeout: command.timeout * 1000,
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private listDetachedPm2ProcessNames(commands: Command[]): string[] {
    return commands.flatMap((command) => {
      if (!command.detached) {
        return [];
      }

      const workingDir = command.working_dir
        ? join(this.cwd, command.working_dir)
        : command.cwd
          ? command.cwd
          : this.cwd;

      return joinContinuationLines(command.run)
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith('#'))
        .map((cmdLine) =>
          buildPm2ProcessName({
            commandName: command.name,
            cmdLine,
            cwd: workingDir,
          }),
        );
    });
  }
}

/**
 * Join lines ending with `\` into single commands, then split on remaining
 * newlines to produce individual command strings.
 */
function joinContinuationLines(script: string): string[] {
  const rawLines = script.split('\n');
  const joined: string[] = [];
  let current = '';

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    if (trimmed.endsWith('\\')) {
      // Strip trailing backslash and append (preserve the space between parts).
      current += (current ? ' ' : '') + trimmed.slice(0, -1).trimEnd();
    } else {
      current += (current ? ' ' : '') + trimmed;
      joined.push(current);
      current = '';
    }
  }

  // Flush any remaining content (e.g. script ending with a trailing backslash).
  if (current) {
    joined.push(current);
  }

  return joined;
}

interface BackgroundProcessOptions {
  /** Shell command to run. */
  cmdLine: string;
  /** Working directory. */
  cwd: string;
  /** Environment variables. */
  env: Record<string, string | undefined>;
  /** Path to write stdout/stderr output. */
  logfile: string;
  /** How to supervise the process after it starts. */
  manager?: DetachedProcessManager;
  /** PM2 process name when manager is "pm2". */
  processName?: string;
}

type Pm2Invocation = {
  command: string;
  argsPrefix: string[];
};

type Pm2Process = {
  name: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    unstable_restarts?: number;
    exit_code?: number;
    pm_cwd?: string;
  };
};

const BACKGROUND_PROCESS_STARTUP_CHECK_MS = 2_000;
const PM2_RESTART_DELAY_MS = 1_000;
const PM2_MAX_RESTARTS = 1_000;
const ROOMOTE_PM2_PROCESS_PREFIX = 'roomote-';

function buildMissingPm2ErrorMessage(): string {
  return [
    'Detached command failed to start under PM2: no PM2 binary was found.',
    `Expected: ${ROOMOTE_BUNDLED_PM2_BINARY_PATH} or \`${ROOMOTE_PATH_PM2_BINARY}\` on PATH.`,
  ].join(' ');
}

/**
 * Start a command in the background and verify it survives the initial startup
 * window. Environment repository commands opt into PM2 supervision; internal
 * service bootstrapping can keep using the legacy shell launcher.
 */
export async function startBackgroundProcess(
  options: BackgroundProcessOptions,
): Promise<void> {
  if (options.manager === 'pm2') {
    await startPm2ManagedProcess(options);
    return;
  }

  await startShellBackgroundProcess(options);
}

async function startShellBackgroundProcess(
  options: BackgroundProcessOptions,
): Promise<void> {
  const { cmdLine, cwd, env, logfile } = options;

  // Write a header to the logfile before spawning.
  appendFileSync(
    logfile,
    `--- ${new Date().toISOString()} ---\n$ ${cmdLine}\ncwd: ${cwd}\n\n`,
  );

  // Shell-safe quoting for the logfile path.
  const quotedLogfile = `'${logfile.replace(/'/g, "'\\''")}'`;

  // The legacy shell launcher intentionally avoids Node's `detached: true`
  // option because its internal `setsid()` call breaks mise shim resolution.
  // Build a shell wrapper that:
  // 1. Ignores HUP (survives parent exit) and PIPE (no broken-pipe deaths)
  // 2. Redirects all output to the logfile via exec (replaces shell's own
  //    FDs so there is zero pipe connection back to the parent process)
  // 3. Runs the actual command
  const wrappedCmd = [
    "trap '' HUP PIPE",
    `exec >> ${quotedLogfile} 2>&1`,
    cmdLine,
  ].join('; ');

  const subprocess = execa(wrappedCmd, {
    shell: '/bin/bash',
    cwd,
    extendEnv: false,
    env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    cleanup: false,
  });

  // Allow the parent's event loop to exit without waiting for this child.
  subprocess.unref();

  // Prevent unhandled rejection if the process crashes after the startup
  // check window — nothing to do, output is already in the logfile.
  subprocess.catch(() => {});

  // Startup check: if the process exits within 2 s it almost certainly
  // hit an immediate error (command not found, permission denied, etc.).
  const earlyExit = await Promise.race([
    subprocess.then(
      () => undefined,
      (e: unknown) => e,
    ),
    new Promise<undefined>((resolve) =>
      setTimeout(resolve, BACKGROUND_PROCESS_STARTUP_CHECK_MS),
    ),
  ]);

  if (earlyExit) {
    // Try to include the logfile contents in the error for diagnostics.
    let logContent = '';

    try {
      logContent = readFileSync(logfile, 'utf-8');
    } catch {
      // Ignore logfile read errors.
    }

    const message =
      earlyExit instanceof ExecaError
        ? earlyExit.shortMessage
        : earlyExit instanceof Error
          ? earlyExit.message
          : String(earlyExit);

    throw new Error(
      `Detached command failed to start: ${message}${logContent ? `\nLog output:\n${logContent.slice(-2000)}` : ''}`,
    );
  }
}

async function startPm2ManagedProcess(
  options: BackgroundProcessOptions,
): Promise<void> {
  const {
    cmdLine,
    cwd,
    env,
    logfile,
    processName = buildPm2ProcessName({
      commandName: 'detached',
      cmdLine,
      cwd,
    }),
  } = options;

  appendFileSync(
    logfile,
    `--- ${new Date().toISOString()} ---\n$ ${cmdLine}\ncwd: ${cwd}\npm2: ${processName}\n\n`,
  );

  const invocation = await resolvePm2Invocation({ cwd, env });

  await runPm2(invocation, ['delete', processName], {
    cwd,
    env,
    reject: false,
  });

  const start = await runPm2(
    invocation,
    buildPm2StartArgs({
      cmdLine,
      cwd,
      logfile,
      processName,
    }),
    {
      cwd,
      env,
      reject: false,
    },
  );

  if (start.exitCode !== 0) {
    throw new Error(
      `Detached command failed to start under PM2: ${start.stderr || start.stdout || `exit code ${start.exitCode}`}`,
    );
  }

  await new Promise((resolve) =>
    setTimeout(resolve, BACKGROUND_PROCESS_STARTUP_CHECK_MS),
  );

  const processStatus = await getPm2Process(invocation, {
    cwd,
    env,
    processName,
  });
  const pm2Env = processStatus?.pm2_env;
  const status = pm2Env?.status;
  const restartCount = pm2Env?.restart_time ?? 0;
  const unstableRestarts = pm2Env?.unstable_restarts ?? 0;
  const exitCode = pm2Env?.exit_code;
  const exitedCleanly = status === 'stopped' && exitCode === 0;

  if (
    processStatus &&
    status === 'online' &&
    restartCount === 0 &&
    unstableRestarts === 0
  ) {
    return;
  }

  if (processStatus && exitedCleanly && restartCount === 0) {
    await runPm2(invocation, ['delete', processName], {
      cwd,
      env,
      reject: false,
    });
    return;
  }

  await runPm2(invocation, ['delete', processName], {
    cwd,
    env,
    reject: false,
  });

  let logContent = '';

  try {
    logContent = readFileSync(logfile, 'utf-8');
  } catch {
    // Ignore logfile read errors.
  }

  throw new Error(
    [
      'Detached command failed to start under PM2',
      `process=${processName}`,
      `status=${status ?? 'missing'}`,
      `restart_time=${restartCount}`,
      `unstable_restarts=${unstableRestarts}`,
      exitCode !== undefined ? `exit_code=${exitCode}` : undefined,
      logContent ? `Log output:\n${logContent.slice(-2000)}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function cleanupStalePm2Processes({
  repoRoot,
  env,
  desiredProcessNames,
}: {
  repoRoot: string;
  env: Record<string, string | undefined>;
  desiredProcessNames: Set<string>;
}): Promise<void> {
  const invocation = await tryResolvePm2Invocation({ cwd: repoRoot, env });

  if (!invocation) {
    if (desiredProcessNames.size === 0) {
      return;
    }

    throw new Error(buildMissingPm2ErrorMessage());
  }

  const processes = await listPm2Processes(invocation, {
    cwd: repoRoot,
    env,
  });

  for (const processName of findStalePm2ProcessNames({
    desiredProcessNames,
    processes,
    repoRoot,
  })) {
    await runPm2(invocation, ['delete', processName], {
      cwd: repoRoot,
      env,
      reject: false,
    });
  }
}

export async function resolvePm2Invocation({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<Pm2Invocation> {
  const invocation = await tryResolvePm2Invocation({ cwd, env });

  if (invocation) {
    return invocation;
  }

  throw new Error(buildMissingPm2ErrorMessage());
}

async function tryResolvePm2Invocation({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<Pm2Invocation | undefined> {
  const candidates: Pm2Invocation[] = [
    {
      command: ROOMOTE_BUNDLED_PM2_BINARY_PATH,
      argsPrefix: [],
    },
    {
      command: ROOMOTE_PATH_PM2_BINARY,
      argsPrefix: [],
    },
  ];

  for (const candidate of candidates) {
    const result = await execa(
      candidate.command,
      [...candidate.argsPrefix, '--version'],
      {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 30_000,
      },
    ).catch(() => undefined);

    if (result?.exitCode === 0) {
      return candidate;
    }
  }
}

async function listPm2Processes(
  invocation: Pm2Invocation,
  {
    cwd,
    env,
  }: {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<Pm2Process[]> {
  const result = await runPm2(invocation, ['jlist'], {
    cwd,
    env,
    reject: false,
  });

  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  try {
    return JSON.parse(result.stdout) as Pm2Process[];
  } catch {
    return [];
  }
}

async function getPm2Process(
  invocation: Pm2Invocation,
  {
    cwd,
    env,
    processName,
  }: {
    cwd: string;
    env: Record<string, string | undefined>;
    processName: string;
  },
): Promise<Pm2Process | undefined> {
  const processes = await listPm2Processes(invocation, { cwd, env });
  return processes.find((candidate) => candidate.name === processName);
}

async function runPm2(
  invocation: Pm2Invocation,
  args: string[],
  {
    cwd,
    env,
    reject,
  }: {
    cwd: string;
    env: Record<string, string | undefined>;
    reject: boolean;
  },
) {
  return execa(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd,
    env,
    extendEnv: false,
    reject,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export function buildPm2ProcessName({
  commandName,
  cmdLine,
  cwd,
}: {
  commandName: string;
  cmdLine: string;
  cwd: string;
}): string {
  const base = `${basename(cwd)}-${commandName}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256')
    .update(`${cwd}\0${commandName}\0${cmdLine}`)
    .digest('hex')
    .slice(0, 10);

  return `${ROOMOTE_PM2_PROCESS_PREFIX}${base || 'detached'}-${hash}`;
}

export function findStalePm2ProcessNames({
  desiredProcessNames,
  processes,
  repoRoot,
}: {
  desiredProcessNames: Set<string>;
  processes: Pm2Process[];
  repoRoot: string;
}): string[] {
  return processes
    .filter(
      (process) =>
        process.name.startsWith(ROOMOTE_PM2_PROCESS_PREFIX) &&
        isManagedProcessForRepo(process, repoRoot) &&
        !desiredProcessNames.has(process.name),
    )
    .map((process) => process.name);
}

function isManagedProcessForRepo(
  process: Pm2Process,
  repoRoot: string,
): boolean {
  const processCwd = process.pm2_env?.pm_cwd;

  if (!processCwd) {
    return false;
  }

  const pathFromRepoRoot = relative(repoRoot, processCwd);
  return (
    pathFromRepoRoot === '' ||
    (!pathFromRepoRoot.startsWith('..') && pathFromRepoRoot !== '..')
  );
}

export function buildPm2StartArgs({
  cmdLine,
  cwd,
  logfile,
  processName,
}: {
  cmdLine: string;
  cwd: string;
  logfile: string;
  processName: string;
}): string[] {
  return [
    'start',
    '/bin/bash',
    '--name',
    processName,
    '--cwd',
    cwd,
    '--time',
    '--log',
    logfile,
    '--restart-delay',
    String(PM2_RESTART_DELAY_MS),
    '--max-restarts',
    String(PM2_MAX_RESTARTS),
    '--',
    '-lc',
    cmdLine,
  ];
}
