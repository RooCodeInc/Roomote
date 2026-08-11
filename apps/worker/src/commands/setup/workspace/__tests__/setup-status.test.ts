import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecutionResult } from '../../../../command-executor';
import {
  EnvironmentSetupStatusWriter,
  readEnvironmentSetupStatus,
  SETUP_STATUS_RELATIVE_PATH,
  type EnvironmentSetupStatus,
} from '../setup-status';

const REPOSITORIES = [
  {
    repository: 'owner/repo',
    commands: [
      {
        name: 'Install deps',
        run: 'pnpm install',
        timeout: 600,
        continue_on_error: false,
      },
      {
        name: 'Start app',
        run: 'pnpm dev',
        timeout: 600,
        continue_on_error: false,
        detached: true,
        logfile: 'dev.log',
      },
    ],
  },
  {
    repository: 'owner/other',
    commands: [],
  },
];

function successResult(name: string): ExecutionResult {
  return {
    command: { name, run: 'true', timeout: 600, continue_on_error: false },
    success: true,
    duration: 1234,
    exitCode: 0,
    stdout: 'installed 100 packages',
    stderr: '',
  };
}

describe('EnvironmentSetupStatusWriter', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-status-'));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  function readStatus(): EnvironmentSetupStatus {
    return JSON.parse(
      fs.readFileSync(
        path.join(workspacePath, SETUP_STATUS_RELATIVE_PATH),
        'utf8',
      ),
    ) as EnvironmentSetupStatus;
  }

  it('publishes a running status even when no repository has commands', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize([{ repository: 'owner/other', commands: [] }]);

    expect(readStatus()).toMatchObject({ state: 'running', commands: [] });

    writer.finalize({ warnings: [] });
    expect(readStatus().state).toBe('completed');
  });

  it('publishes the full pending command plan on initialize', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);

    const status = readStatus();

    expect(status.state).toBe('running');
    expect(status.commands).toEqual([
      expect.objectContaining({
        repository: 'owner/repo',
        name: 'Install deps',
        state: 'pending',
      }),
      expect.objectContaining({
        repository: 'owner/repo',
        name: 'Start app',
        state: 'pending',
        detached: true,
      }),
    ]);
  });

  it('captures secret-safe repository status before setup commands begin', () => {
    const repositoryPath = path.join(workspacePath, 'owner', 'repo');
    fs.mkdirSync(repositoryPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(repositoryPath, 'preexisting.txt'), 'before');

    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES, { 'owner/repo': repositoryPath });

    expect(readStatus().repositoryBaselines).toEqual([
      {
        repository: 'owner/repo',
        path: 'owner/repo',
        changes: ['?? preexisting.txt'],
      },
    ]);
  });

  it('tracks command lifecycle and writes per-command logs', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);

    writer.markCommandRunning('owner/repo', 'Install deps');
    expect(readStatus().commands[0]).toMatchObject({
      state: 'running',
      startedAt: expect.any(String),
    });

    writer.markCommandResult('owner/repo', successResult('Install deps'));

    const entry = readStatus().commands[0]!;
    expect(entry).toMatchObject({
      state: 'succeeded',
      exitCode: 0,
      durationMs: 1234,
    });
    expect(entry.logFile).toBeDefined();

    const logContents = fs.readFileSync(
      path.join(workspacePath, entry.logFile!),
      'utf8',
    );
    expect(logContents).toContain('installed 100 packages');
  });

  it('records detached commands without a workspace log', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);

    writer.markCommandResult('owner/repo', {
      command: {
        name: 'Start app',
        run: 'pnpm dev',
        timeout: 600,
        continue_on_error: false,
        detached: true,
        logfile: 'dev.log',
      },
      success: true,
      duration: 5,
    });

    expect(readStatus().commands[1]).toMatchObject({
      state: 'started_detached',
      logFile: 'dev.log',
    });
  });

  it('finalizes as completed when everything succeeded', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);
    writer.markCommandResult('owner/repo', successResult('Install deps'));
    writer.finalize({ warnings: [] });

    const status = readStatus();
    expect(status.state).toBe('completed');
    expect(status.finishedAt).toEqual(expect.any(String));
  });

  it('finalizes as completed_with_warnings when a command failed', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);
    writer.markCommandResult('owner/repo', {
      ...successResult('Install deps'),
      success: false,
      exitCode: 1,
      error: 'Command failed with exit code 1',
    });
    writer.finalize({
      warnings: ['Optional environment command "Install deps" failed'],
    });

    const status = readStatus();
    expect(status.state).toBe('completed_with_warnings');
    expect(status.commands[0]).toMatchObject({
      state: 'failed',
      exitCode: 1,
      error: 'Command failed with exit code 1',
    });
    expect(status.warnings).toEqual([
      'Optional environment command "Install deps" failed',
    ]);
  });

  it('tracks duplicate command names as separate entries with distinct logs', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize([
      {
        repository: 'owner/repo',
        commands: [
          {
            name: 'Install deps',
            run: 'pnpm install',
            timeout: 600,
            continue_on_error: false,
          },
          {
            name: 'Install deps',
            run: 'pnpm install --dir other',
            timeout: 600,
            continue_on_error: false,
          },
        ],
      },
    ]);

    expect(readStatus().commands).toHaveLength(2);

    // Commands run sequentially, so lifecycle callbacks target the earliest
    // entry still in the expected state.
    writer.markCommandRunning('owner/repo', 'Install deps');
    writer.markCommandResult('owner/repo', successResult('Install deps'));
    writer.markCommandRunning('owner/repo', 'Install deps');
    writer.markCommandResult('owner/repo', {
      ...successResult('Install deps'),
      success: false,
      exitCode: 1,
      error: 'Command failed with exit code 1',
    });

    const status = readStatus();
    expect(status.commands[0]).toMatchObject({ state: 'succeeded' });
    expect(status.commands[1]).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(status.commands[0]!.logFile).toBeDefined();
    expect(status.commands[1]!.logFile).toBeDefined();
    expect(status.commands[0]!.logFile).not.toBe(status.commands[1]!.logFile);
  });

  it('folds accumulated warnings from other setup steps into the final state', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);
    writer.addWarnings(['Background Docker project setup failed: build error']);

    expect(readStatus().warnings).toEqual([
      'Background Docker project setup failed: build error',
    ]);

    writer.markCommandResult('owner/repo', successResult('Install deps'));
    writer.finalize({ warnings: [] });

    const status = readStatus();
    expect(status.state).toBe('completed_with_warnings');
    expect(status.warnings).toEqual([
      'Background Docker project setup failed: build error',
    ]);
  });

  it('finalizes as failed and marks mid-flight commands when setup aborts', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);
    writer.markCommandRunning('owner/repo', 'Install deps');
    writer.finalize({ error: 'Repository path missing' });

    const status = readStatus();
    expect(status.state).toBe('failed');
    expect(status.commands[0]!.state).toBe('failed');
    expect(status.commands[1]!.state).toBe('pending');
    expect(status.warnings).toContain('Repository path missing');
  });
});

describe('readEnvironmentSetupStatus', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'setup-status-read-'),
    );
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('returns null when the status file is missing', () => {
    expect(readEnvironmentSetupStatus(workspacePath)).toBeNull();
  });

  it('returns the written status document', () => {
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(REPOSITORIES);
    writer.markCommandRunning('owner/repo', 'Install deps');
    writer.markCommandResult('owner/repo', successResult('Install deps'));
    writer.finalize({ warnings: [] });

    const status = readEnvironmentSetupStatus(workspacePath);
    expect(status?.state).toBe('completed');
    expect(status?.commands[0]?.logFile).toBe(
      '.roomote/setup-logs/owner/repo/install-deps.log',
    );
  });

  it('returns null when the status document is invalid JSON', () => {
    const statusPath = path.join(workspacePath, SETUP_STATUS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, '{not-json', 'utf8');

    expect(readEnvironmentSetupStatus(workspacePath)).toBeNull();
  });
});
