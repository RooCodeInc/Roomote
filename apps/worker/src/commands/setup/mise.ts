import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { execa } from 'execa';

import type { StartupLogger } from '../../logging';

import { isCommandAvailable } from './command-availability';

const MISE_CONFIG_PATH = homedir() + '/.config/mise/config.toml';

export const RIPGREP_VERSION = '15.1.0';

const MISE_RIPGREP_SPECS = [
  `ripgrep@${RIPGREP_VERSION}`,
  `ubi:BurntSushi/ripgrep@${RIPGREP_VERSION}`,
];

const DEFAULT_MISE_TOOLS = [
  {
    name: 'nodejs',
    spec: 'nodejs@22',
    configPattern: /^\s*nodejs\s*=/m,
  },
  {
    name: 'pnpm',
    spec: 'pnpm@10',
    configPattern: /^\s*pnpm\s*=/m,
  },
  {
    name: 'uv',
    spec: 'uv@latest',
    configPattern: /^\s*uv\s*=/m,
  },
] as const;

/** Upper bound on the Corepack yarn download during serial worker setup. */
const COREPACK_ENABLE_TIMEOUT_MS = 120_000;

/**
 * Upper bound on `yarn --version`. Once Corepack shims are active this is a
 * Corepack entrypoint that can reach the network, so it gets a bound too.
 */
const YARN_PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_PYTHON_PACKAGES = [
  {
    packageName: 'openai',
    moduleName: 'openai',
  },
] as const;

const INSTALL_SYSTEM_PYTHON_PACKAGE_SCRIPT = `
set -euo pipefail
package="$1"
resolve_uv_bin() {
  if command -v mise >/dev/null 2>&1; then
    uv_dir="$(mise where uv 2>/dev/null || true)"
    uv_bin=""

    if [ -n "$uv_dir" ] && [ -x "$uv_dir/uv" ]; then
      printf '%s\\n' "$uv_dir/uv"
      return 0
    fi

    if [ -n "$uv_dir" ]; then
      uv_bin="$(find "$uv_dir" -type f -name uv -perm -111 2>/dev/null | head -n 1)"
    fi

    if [ -n "$uv_bin" ]; then
      printf '%s\\n' "$uv_bin"
      return 0
    fi
  fi

  command -v uv
}

uv_bin="$(resolve_uv_bin)"

if [ "$(id -u)" = "0" ]; then
  "$uv_bin" pip install --system --break-system-packages "$package"
else
  sudo -n "$uv_bin" pip install --system --break-system-packages "$package"
fi
`;

/**
 * Installs mise if it's missing and ensures dependent mise-managed tools exist.
 * Required by tool version setup (workspace manager).
 */
export async function installMise(logger: StartupLogger): Promise<void> {
  if (await isCommandAvailable('mise')) {
    await ensureMiseManagedTools(logger);
    return;
  }

  try {
    await execa('bash', ['-lc', 'curl -fsSL https://mise.run | sh'], {
      stdin: 'ignore',
    });
  } catch (error) {
    logger.debug.error(
      `Failed to install mise: ${error instanceof Error ? error.message : String(error)}`,
    );

    return;
  }

  if (!(await isCommandAvailable('mise'))) {
    logger.debug.warn(
      'mise installation completed but command is still unavailable on PATH',
    );

    return;
  }

  await ensureMiseManagedTools(logger);
}

async function ensureMiseManagedTools(logger: StartupLogger): Promise<void> {
  await ensureDefaultMiseToolsInConfig(logger);
  await ensureCorepackYarnShim(logger);
  await ensureDefaultPythonPackages(logger);
  await installRipgrep(logger);
}

/**
 * Enable Corepack's yarn, prepare a concrete yarn binary, and reshim mise so
 * `yarn` is executable on PATH.
 * Many customer repos (packageManager: yarn@…) run husky pre-push with `yarn`;
 * the default mise toolset only installs node/npm/pnpm, so pushes fail with
 * `yarn: not found` and agents mis-report that as missing Git credentials.
 */
async function ensureCorepackYarnShim(logger: StartupLogger): Promise<void> {
  if (await isYarnExecutable()) {
    logger.debug.log('yarn already available on PATH');
    return;
  }

  logger.debug.log('enabling corepack yarn and reshimming mise');

  try {
    await execa(
      'bash',
      [
        '-lc',
        // Corepack ships with Node and writes its shims next to the resolved
        // corepack binary (`dirname $(which corepack)`), which in this image is
        // inside the mise tree. Scope `enable` to yarn: the unscoped form also
        // writes pnpm/pnpx there, which would shadow the mise-managed pnpm.
        // `prepare … --activate` installs a concrete global yarn so husky works
        // even without a packageManager field, and `mise reshim` republishes
        // the node bin dir (yarn/yarnpkg) through the mise shim directory.
        [
          'corepack enable yarn',
          'corepack prepare yarn@stable --activate',
          'mise reshim',
        ].join(' && '),
      ],
      {
        cwd: homedir(),
        stdin: 'ignore',
        // `prepare` downloads yarn from the registry, and this runs inside the
        // serial setup block that gates task start. Bound it so a throttled or
        // unreachable registry degrades to the warning below instead of
        // hanging the sandbox boot.
        timeout: COREPACK_ENABLE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    logger.userLog.warn(
      `Failed to enable corepack yarn: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (!(await isYarnExecutable())) {
    logger.userLog.warn(
      'corepack enable completed but yarn is still not executable on PATH',
    );
  }
}

/**
 * True when `yarn --version` succeeds. A PATH entry alone is not enough;
 * Corepack shims can exist without a prepared yarn binary.
 */
async function isYarnExecutable(): Promise<boolean> {
  try {
    const result = await execa('yarn', ['--version'], {
      cwd: homedir(),
      reject: false,
      stdin: 'ignore',
      timeout: YARN_PROBE_TIMEOUT_MS,
    });
    // A missing binary surfaces as exitCode undefined (ENOENT), not 1.
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Ensures the default shared runtime tools are configured as global mise tools.
 * The checked-in worker image now bakes this into the global mise config, but
 * we keep the runtime fallback for older images and local environments.
 *
 * Uses `mise use -g` which both installs the tool and registers it globally,
 * unlike `mise install` which only downloads without activating.
 */
async function ensureDefaultMiseToolsInConfig(
  logger: StartupLogger,
): Promise<void> {
  let content: string | undefined;

  try {
    content = await readFile(MISE_CONFIG_PATH, 'utf-8');
  } catch {
    // Config file doesn't exist yet (fresh container) — fall through to install.
  }

  for (const tool of DEFAULT_MISE_TOOLS) {
    if (content && tool.configPattern.test(content)) {
      logger.debug.log(`${tool.name} already configured in mise global config`);
      continue;
    }

    logger.debug.log(`configuring ${tool.name} in mise global config`);

    try {
      await execa('bash', ['-lc', `mise use -g ${tool.spec}`], {
        cwd: homedir(),
        stdin: 'ignore',
      });
    } catch (error) {
      logger.userLog.warn(
        `Failed to configure ${tool.name} in mise: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Installs default Python packages for legacy images that predate the baked
 * worker image package set.
 */
async function ensureDefaultPythonPackages(
  logger: StartupLogger,
): Promise<void> {
  for (const pythonPackage of DEFAULT_PYTHON_PACKAGES) {
    if (await isPythonModuleAvailable(pythonPackage.moduleName)) {
      continue;
    }

    if (!(await isCommandAvailable('uv'))) {
      logger.userLog.warn(
        `Failed to install default Python package ${pythonPackage.packageName}: uv is unavailable`,
      );

      continue;
    }

    logger.debug.log(
      `Installing default Python package ${pythonPackage.packageName}`,
    );

    try {
      await execa(
        'bash',
        [
          '-lc',
          INSTALL_SYSTEM_PYTHON_PACKAGE_SCRIPT,
          '_',
          pythonPackage.packageName,
        ],
        {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
    } catch (error) {
      logger.userLog.warn(
        `Failed to install default Python package ${pythonPackage.packageName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Ensures ripgrep is available on PATH.
 * Required by the sandbox server's file search.
 */
export async function installRipgrep(logger: StartupLogger): Promise<void> {
  const current = await validateRipgrepOnPath();

  if (current.exitCode === 0) {
    return;
  }

  if (!(await isCommandAvailable('mise'))) {
    throw new Error(
      `ripgrep is unavailable and mise is not installed (rg exitCode=${current.exitCode})`,
    );
  }

  for (const toolSpec of MISE_RIPGREP_SPECS) {
    logger.debug.log(`Attempting ripgrep install via mise: ${toolSpec}`);

    const install = await execa('bash', ['-lc', `mise use -g ${toolSpec}`], {
      reject: false,
      stdin: 'ignore',
    });

    if (install.exitCode !== 0) {
      logger.debug.warn(
        `mise install attempt failed for ${toolSpec} (exitCode=${install.exitCode})`,
      );

      if (install.stderr) {
        logger.debug.warn(`mise stderr: ${install.stderr.slice(0, 500)}...`);
      }

      continue;
    }

    const validation = await validateRipgrepOnPath();

    if (validation.exitCode === 0) {
      return;
    }

    logger.debug.warn(
      `ripgrep validation failed after mise install ${toolSpec} (exitCode=${validation.exitCode})`,
    );
  }

  throw new Error(
    `Failed to install ripgrep via mise (attempted: ${MISE_RIPGREP_SPECS.join(', ')})`,
  );
}

async function validateRipgrepOnPath(): Promise<{
  exitCode: number;
  stderr: string;
}> {
  const result = await execa('rg', ['--version'], {
    reject: false,
    stdin: 'ignore',
  });

  return { exitCode: result.exitCode ?? 1, stderr: result.stderr };
}

async function isPythonModuleAvailable(moduleName: string): Promise<boolean> {
  let exitCode: number | undefined;

  try {
    const result = await execa(
      'python',
      [
        '-c',
        [
          'import importlib.util',
          'import sys',
          'sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)',
        ].join('; '),
        moduleName,
      ],
      {
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    exitCode = result.exitCode;
  } catch {
    return false;
  }

  return exitCode === 0;
}
