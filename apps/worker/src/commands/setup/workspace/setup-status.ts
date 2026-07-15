/**
 * Workspace-visible environment setup status.
 *
 * The worker maintains `<workspace>/.roomote/setup-status.json` while
 * repository setup commands run so the coding agent (and anything else in the
 * sandbox) has an observable source of truth for whether setup has finished —
 * especially when setup runs in the background after the agent has already
 * started. Per-command stdout/stderr is mirrored to
 * `<workspace>/.roomote/setup-logs/<repository>/<command>.log`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EnvironmentRepositoryConfig } from '@roomote/types';

import type { ExecutionResult } from '../../../command-executor';

export const SETUP_STATUS_RELATIVE_PATH = '.roomote/setup-status.json';
const SETUP_LOGS_RELATIVE_DIR = '.roomote/setup-logs';

type EnvironmentSetupCommandState =
  | 'pending'
  | 'running'
  | 'started_detached'
  | 'succeeded'
  | 'failed';

export interface EnvironmentSetupCommandStatus {
  repository: string;
  name: string;
  state: EnvironmentSetupCommandState;
  detached?: boolean;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  /** Workspace-relative path to the command's captured output. */
  logFile?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type EnvironmentSetupOverallState =
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export interface EnvironmentSetupStatus {
  version: 1;
  state: EnvironmentSetupOverallState;
  startedAt: string;
  finishedAt?: string;
  commands: EnvironmentSetupCommandStatus[];
  warnings: string[];
}

function commandKey(repository: string, commandName: string): string {
  return `${repository}\u0000${commandName}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'command'
  );
}

/**
 * Maintains the setup status file and per-command logs for one task run.
 *
 * All writes are synchronous and atomic (write to a temp file, then rename)
 * so a reader in the sandbox never observes a torn JSON document.
 */
export class EnvironmentSetupStatusWriter {
  private readonly statusPath: string;
  private readonly logsDir: string;
  // Duplicate command names are valid in the environment schema, so each
  // (repository, name) key maps to every matching entry in plan order.
  // Commands execute sequentially per repository, so lifecycle callbacks
  // always target the earliest entry still in the expected state.
  private readonly commandIndex = new Map<string, number[]>();
  private readonly accumulatedWarnings: string[] = [];
  private status: EnvironmentSetupStatus;

  constructor(private readonly workspacePath: string) {
    this.statusPath = path.join(workspacePath, SETUP_STATUS_RELATIVE_PATH);
    this.logsDir = path.join(workspacePath, SETUP_LOGS_RELATIVE_DIR);
    this.status = {
      version: 1,
      state: 'running',
      startedAt: new Date().toISOString(),
      commands: [],
      warnings: [],
    };
  }

  /**
   * Record the full command plan (every repository command, in execution
   * order) and write the initial `running` status file. Call this before the
   * agent can start so a missing file never means "setup is in progress".
   */
  initialize(repositories: EnvironmentRepositoryConfig[]): void {
    for (const repoConfig of repositories) {
      for (const command of repoConfig.commands ?? []) {
        const key = commandKey(repoConfig.repository, command.name);
        const indices = this.commandIndex.get(key) ?? [];

        indices.push(this.status.commands.length);
        this.commandIndex.set(key, indices);
        this.status.commands.push({
          repository: repoConfig.repository,
          name: command.name,
          state: 'pending',
          ...(command.detached ? { detached: true } : {}),
        });
      }
    }

    this.write();
  }

  /**
   * Record warnings from other environment setup steps (e.g. Docker project
   * startup) so the overall state reflects them even though they are not
   * repository commands.
   */
  addWarnings(messages: string[]): void {
    if (messages.length === 0) {
      return;
    }

    this.accumulatedWarnings.push(...messages);
    this.status.warnings = [...this.accumulatedWarnings];
    this.write();
  }

  markCommandRunning(repository: string, commandName: string): void {
    const found = this.findCommand(repository, commandName, ['pending']);

    if (!found) {
      return;
    }

    found.entry.state = 'running';
    found.entry.startedAt = new Date().toISOString();
    this.write();
  }

  markCommandResult(repository: string, result: ExecutionResult): void {
    const found =
      this.findCommand(repository, result.command.name, ['running']) ??
      this.findCommand(repository, result.command.name, ['pending']);

    if (!found) {
      return;
    }

    const { entry, occurrence } = found;

    if (result.command.detached) {
      // Detached commands return immediately and keep running under PM2;
      // their output goes to the command's own logfile.
      entry.state = result.success ? 'started_detached' : 'failed';

      if (result.command.logfile) {
        entry.logFile = result.command.logfile;
      }
    } else {
      entry.state = result.success ? 'succeeded' : 'failed';
      entry.logFile = this.writeCommandLog(repository, result, occurrence);
    }

    entry.finishedAt = new Date().toISOString();
    entry.durationMs = result.duration;

    if (result.exitCode !== undefined) {
      entry.exitCode = result.exitCode;
    }

    if (result.error) {
      entry.error = result.error;
    }

    this.write();
  }

  /**
   * Mark setup as finished. The overall state is derived from per-command
   * results unless an unexpected error forced a hard failure.
   */
  finalize(options: { warnings?: string[]; error?: string } = {}): void {
    const warnings = [...this.accumulatedWarnings, ...(options.warnings ?? [])];
    const hasFailedCommand = this.status.commands.some(
      (command) => command.state === 'failed',
    );

    if (options.error) {
      // A command that was mid-flight when setup aborted did fail; commands
      // that never started stay `pending` — the overall `failed` state plus
      // the recorded error tell the rest of the story.
      for (const command of this.status.commands) {
        if (command.state === 'running') {
          command.state = 'failed';
        }
      }
    }

    this.status.state = options.error
      ? 'failed'
      : hasFailedCommand || warnings.length > 0
        ? 'completed_with_warnings'
        : 'completed';
    this.status.finishedAt = new Date().toISOString();
    this.status.warnings = options.error
      ? [...warnings, options.error]
      : warnings;
    this.write();
  }

  /**
   * Locate the earliest entry for `(repository, commandName)` whose state is
   * one of `states`. `occurrence` is the entry's position among same-named
   * commands, used to keep duplicate commands' log files distinct.
   */
  private findCommand(
    repository: string,
    commandName: string,
    states: EnvironmentSetupCommandStatus['state'][],
  ): { entry: EnvironmentSetupCommandStatus; occurrence: number } | undefined {
    const indices =
      this.commandIndex.get(commandKey(repository, commandName)) ?? [];

    for (let occurrence = 0; occurrence < indices.length; occurrence += 1) {
      const entry = this.status.commands[indices[occurrence]!];

      if (entry && states.includes(entry.state)) {
        return { entry, occurrence };
      }
    }

    return undefined;
  }

  private writeCommandLog(
    repository: string,
    result: ExecutionResult,
    occurrence: number,
  ): string | undefined {
    const suffix = occurrence > 0 ? `-${occurrence + 1}` : '';
    const relativePath = path.join(
      SETUP_LOGS_RELATIVE_DIR,
      repository,
      `${slugify(result.command.name)}${suffix}.log`,
    );
    const absolutePath = path.join(this.workspacePath, relativePath);

    const sections = [
      `# ${result.command.name} (${repository})`,
      `# exit code: ${result.exitCode ?? (result.success ? 0 : 'unknown')}, duration: ${result.duration}ms`,
      ...(result.error ? [`# error: ${result.error}`] : []),
      ...(result.stdout ? ['', '## stdout', result.stdout] : []),
      ...(result.stderr ? ['', '## stderr', result.stderr] : []),
    ];

    try {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `${sections.join('\n')}\n`, 'utf8');

      return relativePath;
    } catch (error) {
      console.warn(
        `[EnvironmentSetupStatusWriter] Failed to write command log ${relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return undefined;
    }
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
      const tempPath = `${this.statusPath}.tmp`;
      fs.writeFileSync(
        tempPath,
        `${JSON.stringify(this.status, null, 2)}\n`,
        'utf8',
      );
      fs.renameSync(tempPath, this.statusPath);
    } catch (error) {
      console.warn(
        `[EnvironmentSetupStatusWriter] Failed to write ${this.statusPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const ENVIRONMENT_SETUP_COMMAND_STATES = [
  'pending',
  'running',
  'started_detached',
  'succeeded',
  'failed',
] as const;

const ENVIRONMENT_SETUP_OVERALL_STATES = [
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvironmentSetupCommandState(
  value: unknown,
): value is EnvironmentSetupCommandState {
  return (
    typeof value === 'string' &&
    (ENVIRONMENT_SETUP_COMMAND_STATES as readonly string[]).includes(value)
  );
}

function isEnvironmentSetupOverallState(
  value: unknown,
): value is EnvironmentSetupOverallState {
  return (
    typeof value === 'string' &&
    (ENVIRONMENT_SETUP_OVERALL_STATES as readonly string[]).includes(value)
  );
}

function parseEnvironmentSetupStatus(
  value: unknown,
): EnvironmentSetupStatus | null {
  if (!isObject(value) || value.version !== 1) {
    return null;
  }

  if (!isEnvironmentSetupOverallState(value.state)) {
    return null;
  }

  if (typeof value.startedAt !== 'string') {
    return null;
  }

  if (!Array.isArray(value.commands) || !Array.isArray(value.warnings)) {
    return null;
  }

  const commands: EnvironmentSetupCommandStatus[] = [];

  for (const command of value.commands) {
    if (
      !isObject(command) ||
      typeof command.repository !== 'string' ||
      typeof command.name !== 'string' ||
      !isEnvironmentSetupCommandState(command.state)
    ) {
      return null;
    }

    const entry: EnvironmentSetupCommandStatus = {
      repository: command.repository,
      name: command.name,
      state: command.state,
    };

    if (typeof command.detached === 'boolean') {
      entry.detached = command.detached;
    }

    if (typeof command.exitCode === 'number') {
      entry.exitCode = command.exitCode;
    }

    if (typeof command.durationMs === 'number') {
      entry.durationMs = command.durationMs;
    }

    if (typeof command.error === 'string') {
      entry.error = command.error;
    }

    if (typeof command.logFile === 'string') {
      entry.logFile = command.logFile;
    }

    if (typeof command.startedAt === 'string') {
      entry.startedAt = command.startedAt;
    }

    if (typeof command.finishedAt === 'string') {
      entry.finishedAt = command.finishedAt;
    }

    commands.push(entry);
  }

  const warnings = value.warnings.filter(
    (warning): warning is string => typeof warning === 'string',
  );

  if (warnings.length !== value.warnings.length) {
    return null;
  }

  const status: EnvironmentSetupStatus = {
    version: 1,
    state: value.state,
    startedAt: value.startedAt,
    commands,
    warnings,
  };

  if (typeof value.finishedAt === 'string') {
    status.finishedAt = value.finishedAt;
  }

  return status;
}

/**
 * Read and parse `.roomote/setup-status.json` from a workspace. Returns
 * `null` when the file is missing or unreadable/invalid.
 */
export function readEnvironmentSetupStatus(
  workspacePath: string,
): EnvironmentSetupStatus | null {
  const statusPath = path.join(workspacePath, SETUP_STATUS_RELATIVE_PATH);

  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    return parseEnvironmentSetupStatus(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
