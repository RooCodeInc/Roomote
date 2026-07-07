import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isComputeProvider, resolveWorkerRuntimePaths } from '@roomote/types';

import type { StartupLogger } from '../../logging';

import { timedStep } from './logging';

const AGENTS_DIR_NAME = '.agents';
const PACKAGED_SKILLS_DIR_NAME = '.packaged-skills';
const RUNTIME_SKILLS_DIR_NAME = 'skills';
const CLAUDE_DIR_NAME = '.claude';
const DEFAULT_WORKER_INSTALL_DIR = '/sandbox/worker';

interface SyncPackagedAgentHomeOptions {
  homeDir: string;
  workerDir?: string;
}

/**
 * Sets up system state for the worker process.
 * Unlike the bash version which modifies .bashrc, we set process.env directly.
 * Sets up the workspace repos directory.
 */
export async function setupSystem(logger: StartupLogger): Promise<void> {
  logger.userLog.log('Setting up system environment');

  await runSetupSystemStep(
    logger,
    'setupSystem: configure locale and env',
    () => {
      // Fix "setlocale: LC_ALL: cannot change locale" warning.
      // The en_US.UTF-8 locale may not be installed, so use C.UTF-8 which is always available.
      if (!process.env.LC_ALL || process.env.LC_ALL === 'en_US.UTF-8') {
        process.env.LC_ALL = 'C.UTF-8';
      }

      const miseDataDir =
        process.env.MISE_DATA_DIR || `${os.homedir()}/.local/share/mise`;

      // Prepend paths (similar to what the bash script does in .bashrc).
      const pathParts = [
        `${os.homedir()}/.local/bin`,
        `${miseDataDir}/shims`,
        process.env.PATH,
      ].filter(Boolean);

      process.env.PATH = pathParts.join(':');
      process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
      process.env.SKIP_ENV_VALIDATION = '1';
      process.env.DONT_PROMPT_WSL_INSTALL = '1';
    },
  );

  await runSetupSystemStep(
    logger,
    'setupSystem: persist locale export in .bashrc',
    () => {
      // Also write LC_ALL to .bashrc so interactive shells (e.g. terminal commands
      // spawned by the VS Code extension) inherit the locale setting.
      const bashrcPath = path.join(os.homedir(), '.bashrc');
      const bashrcContent = fs.existsSync(bashrcPath)
        ? fs.readFileSync(bashrcPath, 'utf-8')
        : '';

      if (!bashrcContent.includes('export LC_ALL=')) {
        fs.appendFileSync(
          bashrcPath,
          `\nexport LC_ALL='${process.env.LC_ALL}'\n`,
        );
      }
    },
  );

  await runSetupSystemStep(
    logger,
    'setupSystem: ensure workspace repos directory',
    () => {
      const providerFromEnv =
        process.env.COMPUTE_PROVIDER ?? process.env.WORKER_TARGET;

      const runtimePaths =
        providerFromEnv && isComputeProvider(providerFromEnv)
          ? resolveWorkerRuntimePaths({ provider: providerFromEnv })
          : resolveWorkerRuntimePaths({ existsSync: fs.existsSync });

      const reposDir = runtimePaths.workspaceReposDir;

      if (!fs.existsSync(reposDir)) {
        fs.mkdirSync(reposDir, { recursive: true });
      }
    },
  );

  await runSetupSystemStep(
    logger,
    'setupSystem: sync packaged agent home',
    () => {
      syncPackagedAgentHome({
        homeDir: process.env.HOME ?? os.homedir(),
      });
    },
  );
}

async function runSetupSystemStep(
  logger: StartupLogger,
  label: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  logger.debug.log(`${label} (starting)`);
  await timedStep(logger, label, fn);
}

/**
 * Copies the worker-shipped home assets into the real HOME directory so setup
 * and harness startup can rely on stable on-disk paths even after fresh boots
 * or environment-snapshot resumes.
 */
export function syncPackagedAgentHome({
  homeDir,
  workerDir = DEFAULT_WORKER_INSTALL_DIR,
}: SyncPackagedAgentHomeOptions): void {
  const sourceAgentsDir = path.join(workerDir, AGENTS_DIR_NAME);
  const targetAgentsDir = path.join(homeDir, AGENTS_DIR_NAME);

  if (fs.existsSync(sourceAgentsDir)) {
    replaceDirectoryContentsFromSource({
      sourceDir: sourceAgentsDir,
      targetDir: targetAgentsDir,
      preservedEntryNames: [RUNTIME_SKILLS_DIR_NAME],
    });
  }

  const sourcePackagedSkillsDir = path.join(
    workerDir,
    PACKAGED_SKILLS_DIR_NAME,
  );
  const targetPackagedSkillsDir = path.join(homeDir, PACKAGED_SKILLS_DIR_NAME);

  if (fs.existsSync(sourcePackagedSkillsDir)) {
    replaceDirectoryFromSource({
      sourceDir: sourcePackagedSkillsDir,
      targetDir: targetPackagedSkillsDir,
    });
  }

  ensurePhysicalDirectory(path.join(homeDir, CLAUDE_DIR_NAME));
}

function replaceDirectoryFromSource({
  sourceDir,
  targetDir,
}: {
  sourceDir: string;
  targetDir: string;
}): void {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
}

function replaceDirectoryContentsFromSource({
  sourceDir,
  targetDir,
  preservedEntryNames = [],
}: {
  sourceDir: string;
  targetDir: string;
  preservedEntryNames?: string[];
}): void {
  ensurePhysicalDirectory(targetDir);

  const preservedEntries = new Set(preservedEntryNames);

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (preservedEntries.has(entry.name)) {
      continue;
    }

    fs.rmSync(path.join(targetDir, entry.name), {
      recursive: true,
      force: true,
    });
  }

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (preservedEntries.has(entry.name) && fs.existsSync(targetPath)) {
      continue;
    }

    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }
}

function ensurePhysicalDirectory(dirPath: string): void {
  try {
    const stat = fs.lstatSync(dirPath);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Directory does not exist yet.
  }

  fs.mkdirSync(dirPath, { recursive: true });
}
