import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import type { StartupLogger } from '../../logging';

import { isCommandAvailable } from './command-availability';
import { withAptLock } from './package-manager';

const AGENT_BROWSER_VERSION = '0.27.0';

const AGENT_BROWSER_INSTALL_ROOT = '/opt/agent-browser';

const AGENT_BROWSER_CHROME_PATH = '/opt/agent-browser/chrome';

const AGENT_BROWSER_SAVED_CLI_PATH = path.join(
  AGENT_BROWSER_INSTALL_ROOT,
  '.cli-path',
);

const AGENT_BROWSER_INSTALL_MARKER = path.join(
  AGENT_BROWSER_INSTALL_ROOT,
  '.installed',
);

const AGENT_BROWSER_INSTALLER_SCRIPT_NAME = 'install-browser-agent.sh';

const SANDBOX_FILES_DIR = '/sandbox';

const FFMPEG_INSTALLER_VERSION = '1.1.0';

// @ffprobe-installer, not ffprobe-static: the latter ships no linux/arm64
// binary yet still reports a path for it. Keep in sync with the worker
// Dockerfile's FFPROBE_INSTALLER_VERSION so the marker values match.
const FFPROBE_INSTALLER_VERSION = '2.1.2';

const MEDIA_INSTALL_ROOT = '/opt/ffmpeg';

const FFMPEG_EXECUTABLE_PATH =
  process.env.FFMPEG_EXECUTABLE_PATH ?? '/opt/ffmpeg/bin/ffmpeg';

const FFPROBE_EXECUTABLE_PATH =
  process.env.FFPROBE_EXECUTABLE_PATH ?? '/opt/ffmpeg/bin/ffprobe';

const MEDIA_INSTALL_MARKER = path.join(MEDIA_INSTALL_ROOT, '.installed');

const MEDIA_MARKER_VALUE = `${FFMPEG_INSTALLER_VERSION}+${FFPROBE_INSTALLER_VERSION}`;

const USER_BIN_DIR = path.join(os.homedir(), '.local', 'bin');

const PYTHON_USER_SHIM_PATH = path.join(USER_BIN_DIR, 'python');

const PYTHON_SYSTEM_SHIM_PATH = '/usr/local/bin/python';

export async function installBubblewrap(logger: StartupLogger): Promise<void> {
  if (await isCommandAvailable('bwrap')) {
    return;
  }

  logger.debug.log('Installing bubblewrap via apt');

  try {
    await installBubblewrapPackage();
  } catch (error) {
    logger.debug.warn(
      `Failed to install bubblewrap compatibility fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function ensurePython3(
  logger: StartupLogger,
): Promise<string | undefined> {
  let python3Path = await resolveCommandPath('python3');

  if (!python3Path) {
    logger.debug.log('Installing python3 via apt');

    try {
      await installPythonPackage();
    } catch (error) {
      logger.debug.warn(
        `Failed to install python3 compatibility fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    python3Path = await resolveCommandPath('python3');
  }

  if (!python3Path) {
    logger.debug.log(
      'python3 is still unavailable after the compatibility fallback',
    );

    return undefined;
  }

  process.env.PYTHON ??= python3Path;
  return python3Path;
}

export async function installPython(logger: StartupLogger): Promise<void> {
  const python3Path = await ensurePython3(logger);
  if (python3Path) {
    const pythonPath = await resolveCommandPath('python');
    let shouldCreateFallbackShim = !pythonPath;

    if (pythonPath && pythonPath !== PYTHON_USER_SHIM_PATH) {
      shouldCreateFallbackShim = false;
    } else if (pythonPath === PYTHON_USER_SHIM_PATH) {
      const fallbackPythonPath =
        await resolveCommandPathWithoutUserBin('python');

      if (fallbackPythonPath && fallbackPythonPath !== PYTHON_USER_SHIM_PATH) {
        try {
          await fs.promises.rm(PYTHON_USER_SHIM_PATH, { force: true });
        } catch (error) {
          logger.debug.warn(
            `Failed to clear the stale user-local python shim: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        shouldCreateFallbackShim = false;
      }
    }

    if (shouldCreateFallbackShim) {
      try {
        await fs.promises.mkdir(USER_BIN_DIR, { recursive: true });
        await replaceSymlink(PYTHON_USER_SHIM_PATH, python3Path);
      } catch (error) {
        logger.debug.warn(
          `Failed to create the user-local python shim: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        await replaceSymlinkWithSudoFallback(
          PYTHON_SYSTEM_SHIM_PATH,
          python3Path,
        );
      } catch (error) {
        logger.debug.warn(
          `Failed to create the system python shim: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Safety net: guarantee python is available after installPython returns,
  // regardless of what the shim logic above decided.
  if (!(await isCommandAvailable('python'))) {
    logger.debug.warn(
      'python is not available after installPython completed; creating emergency fallback shim',
    );

    const fallbackPython3 =
      python3Path ?? (await resolveCommandPath('python3'));
    if (fallbackPython3) {
      try {
        await fs.promises.mkdir(USER_BIN_DIR, { recursive: true });
        await replaceSymlink(PYTHON_USER_SHIM_PATH, fallbackPython3);
      } catch (error) {
        logger.debug.warn(
          `Failed to create emergency python fallback shim: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export async function installAgentBrowser(
  logger: StartupLogger,
): Promise<void> {
  let realCliPath = await findRealAgentBrowserCliPath();

  const installedVersion =
    await resolveInstalledAgentBrowserVersion(realCliPath);

  const browserReady =
    isExecutableFile(AGENT_BROWSER_CHROME_PATH) && Boolean(realCliPath);

  const needsUpgrade = isAgentBrowserVersionOlder(
    installedVersion,
    AGENT_BROWSER_VERSION,
  );

  const installerScriptPath = findAgentBrowserInstallerScriptPath();

  if (!installerScriptPath) {
    logger.debug.warn('Shared install-browser-agent.sh was not found');
    return;
  }

  if (!browserReady) {
    logger.debug.log('Installing agent-browser');
  } else if (needsUpgrade) {
    logger.debug.log(`Upgrading agent-browser to ${AGENT_BROWSER_VERSION}`);
  }

  try {
    await runAgentBrowserInstallerScript(installerScriptPath);
  } catch (error) {
    logger.debug.warn(
      `Failed to run the shared agent-browser installer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  realCliPath = await findRealAgentBrowserCliPath();

  if (!realCliPath) {
    logger.debug.warn('agent-browser could not resolve a real CLI path');
  }
}

export async function installMediaBinaries(
  logger: StartupLogger,
): Promise<void> {
  process.env.FFMPEG_EXECUTABLE_PATH ??= FFMPEG_EXECUTABLE_PATH;
  process.env.FFPROBE_EXECUTABLE_PATH ??= FFPROBE_EXECUTABLE_PATH;

  const mediaReady =
    isExecutableFile(FFMPEG_EXECUTABLE_PATH) &&
    isExecutableFile(FFPROBE_EXECUTABLE_PATH);

  if (!mediaReady) {
    try {
      await ensureOwnedDirectory(MEDIA_INSTALL_ROOT);
      await ensureOwnedDirectory(path.dirname(FFMPEG_EXECUTABLE_PATH));

      const existingFfmpegPath = await resolveCommandPath('ffmpeg');
      const existingFfprobePath = await resolveCommandPath('ffprobe');

      if (existingFfmpegPath && existingFfprobePath) {
        await replaceSymlink(FFMPEG_EXECUTABLE_PATH, existingFfmpegPath);
        await replaceSymlink(FFPROBE_EXECUTABLE_PATH, existingFfprobePath);
      } else {
        logger.debug.log('Installing ffmpeg/ffprobe compatibility fallback');

        await installGlobalNpmPackages([
          `@ffmpeg-installer/ffmpeg@${FFMPEG_INSTALLER_VERSION}`,
          `@ffprobe-installer/ffprobe@${FFPROBE_INSTALLER_VERSION}`,
        ]);

        const ffmpegBinaryPath = await findInstalledFfmpegNpmBinaryPath();
        const ffprobeBinaryPath = await findInstalledFfprobeNpmBinaryPath();

        if (!ffmpegBinaryPath) {
          throw new Error('ffmpeg binary not found after npm install');
        }

        if (!ffprobeBinaryPath) {
          throw new Error('ffprobe binary not found after npm install');
        }

        await fs.promises.copyFile(ffmpegBinaryPath, FFMPEG_EXECUTABLE_PATH);
        await fs.promises.copyFile(ffprobeBinaryPath, FFPROBE_EXECUTABLE_PATH);
        await fs.promises.chmod(FFMPEG_EXECUTABLE_PATH, 0o755);
        await fs.promises.chmod(FFPROBE_EXECUTABLE_PATH, 0o755);

        await fs.promises.writeFile(
          MEDIA_INSTALL_MARKER,
          `${MEDIA_MARKER_VALUE}\n`,
          'utf8',
        );
      }
    } catch (error) {
      logger.debug.warn(
        `Failed to install the ffmpeg/ffprobe compatibility fallback: ${error instanceof Error ? error.message : String(error)}`,
      );

      return;
    }
  }

  try {
    await fs.promises.mkdir(USER_BIN_DIR, { recursive: true });

    await replaceSymlink(
      path.join(USER_BIN_DIR, 'ffmpeg'),
      FFMPEG_EXECUTABLE_PATH,
    );

    await replaceSymlink(
      path.join(USER_BIN_DIR, 'ffprobe'),
      FFPROBE_EXECUTABLE_PATH,
    );

    await replaceSymlinkWithSudoFallback(
      '/usr/local/bin/ffmpeg',
      FFMPEG_EXECUTABLE_PATH,
    );

    await replaceSymlinkWithSudoFallback(
      '/usr/local/bin/ffprobe',
      FFPROBE_EXECUTABLE_PATH,
    );
  } catch (error) {
    logger.debug.warn(
      `Failed to repair ffmpeg/ffprobe launcher compatibility paths: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function installPythonPackage(): Promise<void> {
  await withAptLock(() =>
    execa(
      'sudo',
      [
        '-n',
        'env',
        'DEBIAN_FRONTEND=noninteractive',
        'apt-get',
        'install',
        '-y',
        'python3',
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
    ),
  );
}

async function installBubblewrapPackage(): Promise<void> {
  await withAptLock(() =>
    execa(
      'sudo',
      [
        '-n',
        'env',
        'DEBIAN_FRONTEND=noninteractive',
        'apt-get',
        'install',
        '-y',
        'bubblewrap',
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
    ),
  );
}

function findAgentBrowserInstallerScriptPath(): string | undefined {
  const candidates = [
    process.env.LOCAL_SANDBOX_FILES_DIR
      ? path.resolve(
          process.env.LOCAL_SANDBOX_FILES_DIR,
          AGENT_BROWSER_INSTALLER_SCRIPT_NAME,
        )
      : undefined,
    path.join(SANDBOX_FILES_DIR, AGENT_BROWSER_INSTALLER_SCRIPT_NAME),
    resolveRepoRelativeInstallerScriptPath(import.meta.url),
  ];

  for (const candidatePath of candidates) {
    if (!candidatePath) {
      continue;
    }

    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

export function resolveRepoRelativeInstallerScriptPath(
  moduleUrl: string,
): string {
  return fileURLToPath(
    new URL(
      '../../../../../.docker/sandbox/install-browser-agent.sh',
      moduleUrl,
    ),
  );
}

async function runAgentBrowserInstallerScript(
  scriptPath: string,
): Promise<void> {
  const runInstaller = () =>
    execa('bash', [scriptPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        AGENT_BROWSER_VERSION,
        AGENT_BROWSER_EXECUTABLE_PATH: AGENT_BROWSER_CHROME_PATH,
      },
    });

  await withAptLock(runInstaller);
}

async function installGlobalNpmPackages(packages: string[]): Promise<void> {
  await execa('npm', ['install', '-g', ...packages], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function findInstalledFfmpegNpmBinaryPath(): Promise<string | undefined> {
  const npmRoot = await resolveGlobalNpmRoot();

  if (!npmRoot) {
    return undefined;
  }

  return resolveNodeExpressionPath(
    `const root=process.argv[1]; const pkg=require(require.resolve("@ffmpeg-installer/ffmpeg", { paths: [root] })); process.stdout.write(pkg.path);`,
    npmRoot,
  );
}

async function findInstalledFfprobeNpmBinaryPath(): Promise<
  string | undefined
> {
  const npmRoot = await resolveGlobalNpmRoot();

  if (!npmRoot) {
    return undefined;
  }

  return resolveNodeExpressionPath(
    `const root=process.argv[1]; const pkg=require(require.resolve("@ffprobe-installer/ffprobe", { paths: [root] })); process.stdout.write(pkg.path);`,
    npmRoot,
  );
}

async function resolveInstalledAgentBrowserVersion(
  realCliPath: string | undefined,
): Promise<string | undefined> {
  if (realCliPath) {
    const cliVersion = await resolveAgentBrowserCliVersion(realCliPath);

    if (cliVersion) {
      return cliVersion;
    }
  }

  const markerVersion = await readTextFile(AGENT_BROWSER_INSTALL_MARKER);

  return markerVersion ? parseAgentBrowserVersion(markerVersion) : undefined;
}

async function findRealAgentBrowserCliPath(): Promise<string | undefined> {
  const savedCliPath = await readTextFile(AGENT_BROWSER_SAVED_CLI_PATH);

  if (savedCliPath && isExecutableFile(savedCliPath)) {
    return savedCliPath;
  }

  const globalBinaryPath = await resolveGlobalNpmBinaryPath('agent-browser');

  if (globalBinaryPath && !isAgentBrowserWrapperScript(globalBinaryPath)) {
    return globalBinaryPath;
  }

  const commandPath = await resolveCommandPath('agent-browser');

  if (commandPath && !isAgentBrowserWrapperScript(commandPath)) {
    return commandPath;
  }

  return undefined;
}

async function resolveAgentBrowserCliVersion(
  realCliPath: string,
): Promise<string | undefined> {
  try {
    const { stdout, stderr, exitCode } = await execa(
      realCliPath,
      ['--version'],
      { reject: false, stdin: 'ignore', stderr: 'pipe' },
    );

    if (exitCode !== 0) {
      return undefined;
    }

    return parseAgentBrowserVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

async function resolveGlobalNpmRoot(): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await execa('npm', ['root', '-g'], {
      reject: false,
      stdin: 'ignore',
      stderr: 'ignore',
    });

    if (exitCode !== 0) {
      return undefined;
    }

    const npmRoot = stdout.trim();
    return npmRoot.length > 0 ? npmRoot : undefined;
  } catch {
    return undefined;
  }
}

async function resolveGlobalNpmBinaryPath(
  binaryName: string,
): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await execa('npm', ['prefix', '-g'], {
      reject: false,
      stdin: 'ignore',
      stderr: 'ignore',
    });

    if (exitCode !== 0) {
      return undefined;
    }

    const prefix = stdout.trim();

    if (!prefix) {
      return undefined;
    }

    const candidatePath = path.join(prefix, 'bin', binaryName);
    return isExecutableFile(candidatePath) ? candidatePath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveNodeExpressionPath(
  expression: string,
  rootPath: string,
): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await execa(
      'node',
      ['-e', expression, rootPath],
      { reject: false, stdin: 'ignore', stderr: 'ignore' },
    );

    if (exitCode !== 0) {
      return undefined;
    }

    const resolvedPath = stdout.trim();

    return resolvedPath && isExecutableFile(resolvedPath)
      ? resolvedPath
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveCommandPath(
  command: string,
): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await execa(
      'bash',
      ['-lc', 'command -v "$1"', '_', command],
      { reject: false, stdin: 'ignore', stderr: 'ignore' },
    );

    return exitCode === 0 ? stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function resolveCommandPathWithoutUserBin(
  command: string,
): Promise<string | undefined> {
  const searchPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry && entry !== USER_BIN_DIR)
    .join(path.delimiter);

  return resolveCommandPathWithPath(command, searchPath);
}

async function resolveCommandPathWithPath(
  command: string,
  searchPath: string | undefined,
): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await execa(
      'bash',
      [
        '-lc',
        'export PATH="$1"; command -v "$2"',
        '_',
        searchPath ?? '',
        command,
      ],
      { reject: false, stdin: 'ignore', stderr: 'ignore' },
    );

    if (exitCode !== 0) {
      return undefined;
    }

    const resolvedPath = stdout.trim();
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  } catch {
    return undefined;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAgentBrowserWrapperScript(filePath: string): boolean {
  try {
    const contents = fs.readFileSync(filePath, 'utf8');

    return contents.includes(
      'agent-browser wrapper: failed to resolve real CLI',
    );
  } catch {
    return false;
  }
}

export function parseAgentBrowserVersion(output: string): string | undefined {
  const match = output.match(/\b(\d+(?:\.\d+)+)\b/);

  return match?.[1];
}

export function compareNumericDotVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue < rightValue) {
      return -1;
    }

    if (leftValue > rightValue) {
      return 1;
    }
  }

  return 0;
}

export function isAgentBrowserVersionOlder(
  installedVersion: string | undefined,
  targetVersion: string,
): boolean {
  if (!installedVersion) {
    return false;
  }

  return compareNumericDotVersions(installedVersion, targetVersion) < 0;
}

async function ensureOwnedDirectory(dirPath: string): Promise<void> {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.access(dirPath, fs.constants.W_OK);
    return;
  } catch {
    // Fall through to the sudo path.
  }

  await execa('sudo', ['-n', 'mkdir', '-p', dirPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });

  await execa('sudo', ['-n', 'chown', '-R', os.userInfo().username, dirPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });

  await fs.promises.access(dirPath, fs.constants.W_OK);
}

async function replaceSymlink(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  await fs.promises.rm(linkPath, { force: true });
  await fs.promises.symlink(targetPath, linkPath);
}

async function replaceSymlinkWithSudoFallback(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.promises.access(path.dirname(linkPath), fs.constants.W_OK);
    await replaceSymlink(linkPath, targetPath);
    return;
  } catch {
    // Fall through to the sudo path.
  }

  await execa('sudo', ['-n', 'mkdir', '-p', path.dirname(linkPath)], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });

  await execa('sudo', ['-n', 'ln', '-sf', targetPath, linkPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return (await fs.promises.readFile(filePath, 'utf8')).trim();
  } catch {
    return undefined;
  }
}
