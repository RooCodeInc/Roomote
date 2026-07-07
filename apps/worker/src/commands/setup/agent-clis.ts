import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execa } from 'execa';
import { resolveWorkerRuntimePaths } from '@roomote/types';

import type { StartupLogger } from '../../logging';

import { formatDurationMs } from './logging';
import { resolveNpmInstallCommand } from './npm-install-command';
import {
  getSharedSandboxRuntimePackageSpecs,
  resolveExpectedOpenCodeCliVersion,
  usesSharedSandboxRuntimePackages,
} from './shared-runtime-packages';
export {
  DEFAULT_OPENCODE_CLI_VERSION,
  ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV,
  ROOMOTE_OPENCODE_CLI_VERSION_ENV,
} from './shared-runtime-packages';

type Installer = {
  command: string;
  expectedVersion: string;
  label: string;
  installMethod: 'npm';
  packageName?: string;
};

function getInstallers(env: NodeJS.ProcessEnv = process.env): Installer[] {
  return [
    {
      command: 'opencode',
      expectedVersion: resolveExpectedOpenCodeCliVersion(env),
      label: 'OpenCode CLI',
      installMethod: 'npm',
      packageName: 'opencode-ai',
    },
  ];
}

function parseInstalledCliVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/u.exec(output.trim());
  return match?.[1] ?? null;
}

async function readInstalledCliVersion(
  command: string,
): Promise<string | null> {
  try {
    const { exitCode, stdout, stderr } = await execa(command, ['--version'], {
      reject: false,
      stdin: 'ignore',
    });

    if (exitCode !== 0) {
      return null;
    }

    return parseInstalledCliVersion([stdout, stderr].join('\n'));
  } catch {
    return null;
  }
}

function ensureCliWrappers(options: {
  commands: string[];
  binaryPath: string;
}): void {
  const binDir = path.join(os.homedir(), '.local', 'bin');

  fs.mkdirSync(binDir, { recursive: true });

  for (const command of options.commands) {
    const wrapperPath = path.join(binDir, command);

    fs.writeFileSync(
      wrapperPath,
      `#!/bin/bash\nexec ${JSON.stringify(options.binaryPath)} "$@"\n`,
      'utf8',
    );
    fs.chmodSync(wrapperPath, 0o755);
  }
}

function resolveInstalledBinaryPath(options: {
  installRoot: string;
  command: string;
}): string {
  return path.join(
    options.installRoot,
    'node_modules',
    '.bin',
    options.command,
  );
}

function ensureCliWrapperForInstaller(options: {
  installer: Installer;
  binaryPath: string;
}): void {
  ensureCliWrappers({
    commands: [options.installer.command],
    binaryPath: options.binaryPath,
  });
}

function ensureSharedNpmCliWrappers(options: {
  installers: Installer[];
  installRoot: string;
}): void {
  for (const installer of options.installers) {
    if (installer.installMethod !== 'npm') {
      continue;
    }

    ensureCliWrapperForInstaller({
      installer,
      binaryPath: resolveInstalledBinaryPath({
        installRoot: options.installRoot,
        command: installer.command,
      }),
    });
  }
}

/**
 * Ensures external CLIs needed for interactive authentication flows are
 * available at the expected version. The worker image bakes them in, while
 * this installer remains as a compatibility fallback for older images and
 * local environments.
 */
export async function installAgentClis(logger: StartupLogger): Promise<void> {
  const npmInstallCommand = await resolveNpmInstallCommand();
  const runtimePaths = resolveWorkerRuntimePaths({
    existsSync: fs.existsSync,
  });
  const installers = getInstallers();

  for (const item of installers) {
    const installedVersion = await readInstalledCliVersion(item.command);

    if (installedVersion === item.expectedVersion) {
      continue;
    }

    const installStartedAt = Date.now();

    const installRoot = runtimePaths.sandboxRootDir;

    const installedBinaryPath = resolveInstalledBinaryPath({
      installRoot,
      command: item.command,
    });

    try {
      logger.debug.log(
        installedVersion
          ? `${item.label} version mismatch (${installedVersion}); installing ${item.expectedVersion}`
          : `${item.label} missing; installing ${item.expectedVersion}`,
      );

      fs.mkdirSync(installRoot, { recursive: true });

      const usesSharedNpmPackageSet =
        item.installMethod === 'npm' &&
        usesSharedSandboxRuntimePackages(runtimePaths);

      const packageSpecs = usesSharedNpmPackageSet
        ? getSharedSandboxRuntimePackageSpecs(process.env)
        : [`${item.packageName}@${item.expectedVersion}`];

      await execa(
        npmInstallCommand.command,
        [
          ...npmInstallCommand.argsPrefix,
          'install',
          '--prefix',
          installRoot,
          '--no-save',
          '--no-package-lock',
          ...packageSpecs,
        ],
        {
          stdin: 'ignore',
        },
      );

      const installedBinaryVersion =
        await readInstalledCliVersion(installedBinaryPath);

      if (installedBinaryVersion !== item.expectedVersion) {
        throw new Error(
          `expected ${item.expectedVersion} at ${installedBinaryPath}, found ${installedBinaryVersion ?? 'unknown'}`,
        );
      }

      if (usesSharedNpmPackageSet) {
        ensureSharedNpmCliWrappers({
          installers,
          installRoot,
        });
      } else {
        ensureCliWrapperForInstaller({
          installer: item,
          binaryPath: installedBinaryPath,
        });
      }

      const validatedVersion = await readInstalledCliVersion(item.command);

      if (validatedVersion !== item.expectedVersion) {
        throw new Error(
          `expected ${item.expectedVersion} from ${item.command} --version, found ${validatedVersion ?? 'unknown'}`,
        );
      }

      logger.debug.log(
        `${item.label} installed at ${validatedVersion} in ${formatDurationMs(Date.now() - installStartedAt)}`,
      );
    } catch (error) {
      logger.debug.error(
        `Failed to install ${item.label}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error;
    }
  }
}
