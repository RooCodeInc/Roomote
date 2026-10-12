import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentRepositoryConfig } from '@roomote/types';

import type { StartupLogger } from '../../../../logging';
import { executeOrganizationEnvironmentRepositoryCommands } from '../environment-commands';
import { EnvironmentSetupStatusWriter } from '../setup-status';

describe('environment repository command failure policy', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'roomote-setup-policy-'));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  function execute(
    continueRepositoryCommandFailures: boolean,
    optional = false,
    exitCode = 23,
  ) {
    const repositories: EnvironmentRepositoryConfig[] = [
      {
        repository: 'example/app',
        commands: [
          {
            name: 'Required setup',
            run: `${JSON.stringify(process.execPath)} -e "process.exit(${exitCode})"`,
            timeout: 10,
            continue_on_error: optional,
          },
          {
            name: 'Dependent setup',
            run: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('dependent-ran', 'yes')"`,
            timeout: 10,
            continue_on_error: false,
          },
        ],
      },
    ];
    const writer = new EnvironmentSetupStatusWriter(workspacePath);
    writer.initialize(repositories);
    const logger = {
      userLog: { warn: vi.fn() },
      debug: { warn: vi.fn() },
    } as unknown as StartupLogger;
    const result = executeOrganizationEnvironmentRepositoryCommands(logger, {
      environment: {
        type: 'environment',
        environmentId: 'fixture-env',
        environmentConfig: { name: 'Test app', repositories },
      },
      envVars: { PATH: process.env.PATH },
      preparedWorkspace: {
        workspacePath,
        environment: { repoPaths: { 'example/app': workspacePath } },
      },
      continueRepositoryCommandFailures,
      setupStatusWriter: writer,
    });
    return { result, logger };
  }

  async function status() {
    return JSON.parse(
      await readFile(join(workspacePath, '.roomote/setup-status.json'), 'utf8'),
    );
  }

  it('stops required snapshot setup, skips dependent commands and persists failure', async () => {
    const { result, logger } = execute(false);
    await expect(result).rejects.toThrow('exit code 23');
    await expect(
      access(join(workspacePath, 'dependent-ran')),
    ).rejects.toThrow();
    const recorded = await status();
    expect(recorded.state).toBe('failed');
    expect(recorded.finishedAt).toBeDefined();
    expect(
      recorded.commands.map((command: { state: string }) => command.state),
    ).toEqual(['failed', 'pending']);
    expect(recorded.commands[0].exitCode).toBe(23);
    expect(
      await readFile(join(workspacePath, recorded.commands[0].logFile), 'utf8'),
    ).toContain('# exit code: 23');
    expect(logger.userLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Continuing without'),
    );
  });

  it('completes snapshot setup after the prerequisite failure is removed', async () => {
    const { result } = execute(false, false, 0);
    await expect(result).resolves.toEqual([]);
    expect(await readFile(join(workspacePath, 'dependent-ran'), 'utf8')).toBe(
      'yes',
    );
    const recorded = await status();
    expect(recorded.state).toBe('completed');
    expect(
      recorded.commands.map((command: { state: string }) => command.state),
    ).toEqual(['succeeded', 'succeeded']);
  });

  it.each([
    { continuation: true, optional: false },
    { continuation: false, optional: true },
  ])(
    'preserves ordinary task or explicitly optional continuation: %j',
    async ({ continuation, optional }) => {
      const { result } = execute(continuation, optional);
      await expect(result).resolves.toHaveLength(1);
      expect(await readFile(join(workspacePath, 'dependent-ran'), 'utf8')).toBe(
        'yes',
      );
      const recorded = await status();
      expect(recorded.state).toBe('completed_with_warnings');
      expect(
        recorded.commands.map((command: { state: string }) => command.state),
      ).toEqual(['failed', 'succeeded']);
    },
  );
});
