import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { execa } from 'execa';

import type { HarnessLogger } from '../../../../logging';
import { resolveNpmInstallCommand } from '../../../../commands/setup/npm-install-command';
import {
  DEFAULT_OPENCODE_CLI_VERSION,
  resolveExpectedOpenCodeCliVersion,
} from '../../../../commands/setup/shared-runtime-packages';

const OPENCODE_PLUGIN_PACKAGE_NAME = '@opencode-ai/plugin';
const DEFAULT_OPENCODE_PLUGIN_SEED_TIMEOUT_MS = 60_000;
const ROOMOTE_OPENCODE_PLUGIN_SEED_DIR_ENV = 'ROOMOTE_OPENCODE_PLUGIN_SEED_DIR';
/** Default image-baked seed directory for worker sandboxes. */
const DEFAULT_OPENCODE_PLUGIN_SEED_DIR = '/opt/roomote/opencode-plugin-seed';

type OpenCodePluginSeedResult = 'already-complete' | 'copied' | 'installed';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type PackageLockJson = {
  packages?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
};

type SeedOpenCodePluginDependenciesOptions = {
  configDir: string;
  version: string;
  logger: HarnessLogger;
  timeoutMs?: number;
  /**
   * Candidate directories that already contain a full seed to copy from.
   * Defaults to `ROOMOTE_OPENCODE_PLUGIN_SEED_DIR` and the image bake path.
   */
  seedDirs?: string[];
  env?: NodeJS.ProcessEnv;
  install?: (options: {
    configDir: string;
    version: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function dependencyMapVersion(
  dependencies: Record<string, string> | undefined,
  packageName: string,
): string | undefined {
  const raw = dependencies?.[packageName]?.trim();
  if (!raw) {
    return undefined;
  }

  return raw.replace(/^[\^~>=<\s]+/u, '');
}

/**
 * True when OpenCode's Npm.install check would no-op for `@opencode-ai/plugin`
 * (node_modules present and lock covers the declared dependency name) and the
 * installed package version matches the pinned OpenCode release.
 */
export async function isOpenCodePluginSeedComplete(options: {
  configDir: string;
  version: string;
}): Promise<boolean> {
  const packageJsonPath = path.join(options.configDir, 'package.json');
  const lockPath = path.join(options.configDir, 'package-lock.json');
  const installedPackageJsonPath = path.join(
    options.configDir,
    'node_modules',
    ...OPENCODE_PLUGIN_PACKAGE_NAME.split('/'),
    'package.json',
  );

  const [packageJsonRaw, lockRaw, installedPackageJsonRaw] = await Promise.all([
    readJsonFile(packageJsonPath),
    readJsonFile(lockPath),
    readJsonFile(installedPackageJsonPath),
  ]);

  if (
    !isRecord(packageJsonRaw) ||
    !isRecord(lockRaw) ||
    !isRecord(installedPackageJsonRaw)
  ) {
    return false;
  }

  const packageJson = packageJsonRaw as PackageJson;
  const declaredVersion =
    dependencyMapVersion(
      packageJson.dependencies,
      OPENCODE_PLUGIN_PACKAGE_NAME,
    ) ??
    dependencyMapVersion(
      packageJson.devDependencies,
      OPENCODE_PLUGIN_PACKAGE_NAME,
    ) ??
    dependencyMapVersion(
      packageJson.optionalDependencies,
      OPENCODE_PLUGIN_PACKAGE_NAME,
    );

  if (declaredVersion !== options.version) {
    return false;
  }

  const lock = lockRaw as PackageLockJson;
  const root = lock.packages?.[''] ?? {};
  const lockedNames = new Set([
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {}),
    ...Object.keys(root.peerDependencies ?? {}),
    ...Object.keys(root.optionalDependencies ?? {}),
  ]);

  if (!lockedNames.has(OPENCODE_PLUGIN_PACKAGE_NAME)) {
    return false;
  }

  const installedVersion =
    typeof installedPackageJsonRaw.version === 'string'
      ? installedPackageJsonRaw.version.trim()
      : '';

  return installedVersion === options.version;
}

/**
 * Writes a minimal but OpenCode-complete seed tree for unit tests (not a real
 * plugin install — only satisfies seed completeness checks).
 */
export function writeOpenCodePluginSeedFixture(options: {
  configDir: string;
  version: string;
}): void {
  const pluginDir = path.join(
    options.configDir,
    'node_modules',
    ...OPENCODE_PLUGIN_PACKAGE_NAME.split('/'),
  );
  fsSync.mkdirSync(pluginDir, { recursive: true });
  fsSync.writeFileSync(
    path.join(options.configDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'opencode',
        private: true,
        dependencies: {
          [OPENCODE_PLUGIN_PACKAGE_NAME]: options.version,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fsSync.writeFileSync(
    path.join(options.configDir, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'opencode',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            dependencies: {
              [OPENCODE_PLUGIN_PACKAGE_NAME]: options.version,
            },
          },
          [`node_modules/${OPENCODE_PLUGIN_PACKAGE_NAME}`]: {
            version: options.version,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fsSync.writeFileSync(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify(
      {
        name: OPENCODE_PLUGIN_PACKAGE_NAME,
        version: options.version,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export async function resolveOpenCodePluginSeedVersion(options: {
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
}): Promise<string> {
  const env = options.env ?? process.env;
  const expected = resolveExpectedOpenCodeCliVersion(env);

  try {
    const result = await execa('opencode', ['--version'], {
      reject: false,
      stdin: 'ignore',
      env: {
        ...env,
        ...(options.pathEnv ? { PATH: options.pathEnv } : {}),
      },
    });

    if (result.exitCode === 0) {
      const match = /(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/u.exec(
        [result.stdout, result.stderr].join('\n'),
      );
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // Fall through to expected/default.
  }

  return expected || DEFAULT_OPENCODE_CLI_VERSION;
}

function resolveSeedSourceDirs(options: {
  env: NodeJS.ProcessEnv;
  seedDirs?: string[];
}): string[] {
  if (options.seedDirs) {
    return options.seedDirs;
  }

  const fromEnv =
    options.env[ROOMOTE_OPENCODE_PLUGIN_SEED_DIR_ENV]?.trim() ||
    process.env[ROOMOTE_OPENCODE_PLUGIN_SEED_DIR_ENV]?.trim();
  return [...(fromEnv ? [fromEnv] : []), DEFAULT_OPENCODE_PLUGIN_SEED_DIR];
}

async function copySeedTree(options: {
  sourceDir: string;
  targetDir: string;
}): Promise<void> {
  await fs.mkdir(options.targetDir, { recursive: true });

  for (const entry of [
    'package.json',
    'package-lock.json',
    'node_modules',
  ] as const) {
    const sourcePath = path.join(options.sourceDir, entry);
    const targetPath = path.join(options.targetDir, entry);
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
}

async function defaultInstall(options: {
  configDir: string;
  version: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await fs.mkdir(options.configDir, { recursive: true });
  await fs.writeFile(
    path.join(options.configDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'opencode',
        private: true,
        dependencies: {
          [OPENCODE_PLUGIN_PACKAGE_NAME]: options.version,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Drop incomplete seed leftovers so npm does not inherit a stalled cache
  // tree for the same path.
  await fs.rm(path.join(options.configDir, 'node_modules'), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(options.configDir, 'package-lock.json'), {
    force: true,
  });

  const npmInstallCommand = await resolveNpmInstallCommand();
  await execa(
    npmInstallCommand.command,
    [
      ...npmInstallCommand.argsPrefix,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: options.configDir,
      env: options.env,
      timeout: options.timeoutMs,
      stdin: 'ignore',
    },
  );
}

/**
 * Ensures OpenCode's global config-dir `@opencode-ai/plugin` install is already
 * complete before `opencode serve` / first `POST /session`, so bootstrap does
 * not block on a live registry fetch during `waitForDependencies()`.
 */
export async function seedOpenCodePluginDependencies(
  options: SeedOpenCodePluginDependenciesOptions,
): Promise<OpenCodePluginSeedResult> {
  const env = options.env ?? process.env;
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_OPENCODE_PLUGIN_SEED_TIMEOUT_MS;
  const install = options.install ?? defaultInstall;

  if (
    await isOpenCodePluginSeedComplete({
      configDir: options.configDir,
      version: options.version,
    })
  ) {
    options.logger.info(
      `OpenCode plugin seed already complete configDir=${options.configDir} version=${options.version}`,
    );
    return 'already-complete';
  }

  for (const sourceDir of resolveSeedSourceDirs({
    env,
    seedDirs: options.seedDirs,
  })) {
    if (
      !(await isOpenCodePluginSeedComplete({
        configDir: sourceDir,
        version: options.version,
      }))
    ) {
      continue;
    }

    options.logger.info(
      `Copying OpenCode plugin seed sourceDir=${sourceDir} configDir=${options.configDir} version=${options.version}`,
    );
    await copySeedTree({
      sourceDir,
      targetDir: options.configDir,
    });

    if (
      !(await isOpenCodePluginSeedComplete({
        configDir: options.configDir,
        version: options.version,
      }))
    ) {
      throw new Error(
        `Copied OpenCode plugin seed from ${sourceDir} but configDir=${options.configDir} is still incomplete for version=${options.version}`,
      );
    }

    return 'copied';
  }

  options.logger.info(
    `Installing OpenCode plugin seed configDir=${options.configDir} version=${options.version} timeoutMs=${timeoutMs}`,
  );

  try {
    await install({
      configDir: options.configDir,
      version: options.version,
      timeoutMs,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to install OpenCode plugin seed (@opencode-ai/plugin@${options.version}) into ${options.configDir} within ${timeoutMs}ms: ${message}`,
      { cause: error },
    );
  }

  if (
    !(await isOpenCodePluginSeedComplete({
      configDir: options.configDir,
      version: options.version,
    }))
  ) {
    throw new Error(
      `OpenCode plugin seed install finished but configDir=${options.configDir} is still incomplete for version=${options.version}`,
    );
  }

  options.logger.info(
    `Installed OpenCode plugin seed configDir=${options.configDir} version=${options.version}`,
  );
  return 'installed';
}
