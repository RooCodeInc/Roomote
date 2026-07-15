import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import {
  type WorkerRuntimePaths,
  resolveWorkerRuntimePaths,
} from '@roomote/types';

import type { StartupLogger } from '../../logging';

import { formatDurationMs } from './logging';
import { resolveNpmInstallCommand } from './npm-install-command';
import {
  NODE_PTY_PACKAGE_SPEC,
  getSharedSandboxRuntimePackageSpecs,
  usesSharedSandboxRuntimePackages,
} from './shared-runtime-packages';

/**
 * Ensures the node-pty native module is available.
 * The worker image bakes it into the shared sandbox runtime, while this
 * installer remains as a compatibility fallback for older images and local
 * environments.
 */
export async function installNodePty(logger: StartupLogger): Promise<void> {
  try {
    // node-pty is a native module that must be compiled at install time.
    // We use require() here (not import()) because we only need to check
    // whether the module is resolvable — not actually load it. A failed
    // require() throws synchronously, which is cheap to catch.
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    require('node-pty');
    return;
  } catch {
    // Not found, proceed with install.
  }

  // The bundled worker.js lives inside the extracted worker release directory.
  // In sandbox runtimes we install into the shared sandbox root so the module
  // survives worker refreshes and resolves via /sandbox/node_modules.
  // Local runs fall back to the worker directory because the dist path lives
  // inside the repo and resolves modules from its ancestor directories.
  const runtimePaths = resolveWorkerRuntimePaths({ existsSync: fs.existsSync });

  const installRoot = resolveNodePtyInstallRoot({
    moduleUrl: import.meta.url,
    runtimePaths,
  });
  const packageSpecs = getNodePtyInstallPackageSpecs(runtimePaths);

  fs.mkdirSync(installRoot, { recursive: true });

  try {
    const installStartedAt = Date.now();
    const npmInstallCommand = await resolveNpmInstallCommand();

    logger.debug.log(
      usesSharedSandboxRuntimePackages(runtimePaths)
        ? 'Installing shared runtime packages to repair node-pty'
        : 'Installing node-pty',
    );

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

    logger.debug.log(
      `node-pty install completed in ${formatDurationMs(Date.now() - installStartedAt)} (installRoot=${installRoot})`,
    );
  } catch (error) {
    logger.userLog.error(
      `Failed to install node-pty: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getNodePtyInstallPackageSpecs(
  runtimePaths: WorkerRuntimePaths,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (usesSharedSandboxRuntimePackages(runtimePaths)) {
    return getSharedSandboxRuntimePackageSpecs(env);
  }

  return [NODE_PTY_PACKAGE_SPEC];
}

export function resolveNodePtyInstallRoot({
  moduleUrl,
  runtimePaths,
}: {
  moduleUrl: string;
  runtimePaths: WorkerRuntimePaths;
}): string {
  if (runtimePaths.runtime !== 'local') {
    return runtimePaths.sandboxRootDir;
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));

  // This module lives under src/commands/setup/ in local runs and
  // dist/commands/setup/ in bundled worker runs. Walking three levels up lands
  // at the worker package root in both cases so node module resolution from
  // sandbox-server code can still find the installed native module.
  return path.resolve(moduleDir, '..', '..', '..');
}
