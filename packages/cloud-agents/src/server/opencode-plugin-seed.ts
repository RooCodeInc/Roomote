import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OpenCode Arborist-installs `@opencode-ai/plugin` into every config
 * directory it loads (the XDG global one and `OPENCODE_CONFIG_DIR`) and, when
 * any plugin is configured, blocks instance bootstrap on that install. In a
 * fresh container those directories start empty, so the first request after
 * every deploy paid a cold registry install (minutes on a slow path, and a
 * hard failure once it outran the SDK's 300s headers timeout). The app image
 * bakes a complete install; this module copies it into place before the
 * server is spawned so OpenCode's own `Npm.install` check no-ops.
 */

export const OPENCODE_PLUGIN_PACKAGE_NAME = '@opencode-ai/plugin';
export const OPENCODE_PLUGIN_SEED_DIR_ENV = 'ROOMOTE_OPENCODE_PLUGIN_SEED_DIR';
/** Image bake path shared with the worker image's sandbox seed. */
const DEFAULT_OPENCODE_PLUGIN_SEED_DIR = '/opt/roomote/opencode-plugin-seed';

/** Copied verbatim; package.json is merged instead (see below). */
const SEED_COPY_ENTRIES = ['package-lock.json', 'node_modules'];

type OpenCodePluginSeedResult = 'already-complete' | 'copied' | 'no-seed';

type DependencyMaps = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyNames(maps: DependencyMaps): Set<string> {
  return new Set([
    ...Object.keys(maps.dependencies ?? {}),
    ...Object.keys(maps.devDependencies ?? {}),
    ...Object.keys(maps.peerDependencies ?? {}),
    ...Object.keys(maps.optionalDependencies ?? {}),
  ]);
}

/**
 * Mirrors OpenCode's `Npm.install` short-circuit: `node_modules` exists and
 * the lockfile root lists every declared dependency, including the plugin
 * OpenCode itself adds. Also requires the installed plugin to match the
 * declared version so a stale seed never masquerades as complete.
 */
export function isOpenCodePluginSeedComplete(configDir: string): boolean {
  const packageJson = readJson(join(configDir, 'package.json'));
  const lock = readJson(join(configDir, 'package-lock.json'));
  const installed = readJson(
    join(
      configDir,
      'node_modules',
      ...OPENCODE_PLUGIN_PACKAGE_NAME.split('/'),
      'package.json',
    ),
  );
  if (!isRecord(packageJson) || !isRecord(lock) || !isRecord(installed)) {
    return false;
  }

  const declared = dependencyNames(packageJson as DependencyMaps);
  declared.add(OPENCODE_PLUGIN_PACKAGE_NAME);
  const packages = isRecord(lock.packages) ? lock.packages : {};
  const root = isRecord(packages['']) ? packages[''] : {};
  const locked = dependencyNames(root as DependencyMaps);
  for (const name of declared) {
    if (!locked.has(name)) return false;
  }

  const declaredVersion = (packageJson as DependencyMaps).dependencies?.[
    OPENCODE_PLUGIN_PACKAGE_NAME
  ]
    ?.trim()
    .replace(/^[\^~>=<\s]+/u, '');
  return (
    typeof installed.version === 'string' &&
    installed.version.trim() !== '' &&
    (declaredVersion === undefined ||
      installed.version.trim() === declaredVersion)
  );
}

function resolveOpenCodePluginSeedSourceDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env[OPENCODE_PLUGIN_SEED_DIR_ENV]?.trim() ||
    DEFAULT_OPENCODE_PLUGIN_SEED_DIR
  );
}

/**
 * The directories OpenCode will install into for a server launched with
 * `env`: `OPENCODE_CONFIG_DIR` when set, plus the XDG global config dir
 * (`$XDG_CONFIG_HOME/opencode`, else `$HOME/.config/opencode`).
 */
export function resolveOpenCodePluginInstallDirs(
  env: NodeJS.ProcessEnv,
): string[] {
  const xdgConfigHome =
    env.XDG_CONFIG_HOME?.trim() ||
    join(env.HOME?.trim() || homedir(), '.config');
  const globalDir = join(xdgConfigHome, 'opencode');
  const configDir = env.OPENCODE_CONFIG_DIR?.trim();
  return configDir && configDir !== globalDir
    ? [configDir, globalDir]
    : [globalDir];
}

let missingSeedWarned = false;

/**
 * Copies the image-baked plugin install into `configDir` unless it is already
 * complete. Returns `no-seed` (and keeps OpenCode's own install as the
 * fallback) when the image has no usable seed, which is the local-dev case.
 */
export function seedOpenCodePluginDependencies(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenCodePluginSeedResult {
  if (isOpenCodePluginSeedComplete(configDir)) return 'already-complete';

  const sourceDir = resolveOpenCodePluginSeedSourceDir(env);
  if (!existsSync(sourceDir) || !isOpenCodePluginSeedComplete(sourceDir)) {
    if (!missingSeedWarned && existsSync(DEFAULT_OPENCODE_PLUGIN_SEED_DIR)) {
      missingSeedWarned = true;
      console.warn(
        `[OpenCode] Plugin seed at ${sourceDir} is incomplete; OpenCode will install ${OPENCODE_PLUGIN_PACKAGE_NAME} from the registry on first boot.`,
      );
    }
    return 'no-seed';
  }

  mkdirSync(configDir, { recursive: true });
  // Merge rather than replace package.json: the shared Fast tools directory
  // already carries `type: "module"` for its ESM tool files (as OpenCode's
  // own Arborist install would have preserved), so only the dependency
  // declarations come from the seed.
  const existingPackageJson = readJson(join(configDir, 'package.json'));
  const seedPackageJson = readJson(join(sourceDir, 'package.json'));
  for (const entry of SEED_COPY_ENTRIES) {
    cpSync(join(sourceDir, entry), join(configDir, entry), {
      recursive: true,
      force: true,
    });
  }
  const mergedPackageJson = {
    ...(isRecord(existingPackageJson)
      ? existingPackageJson
      : isRecord(seedPackageJson)
        ? seedPackageJson
        : {}),
    dependencies: {
      ...(isRecord(existingPackageJson) &&
      isRecord(existingPackageJson.dependencies)
        ? existingPackageJson.dependencies
        : {}),
      ...(isRecord(seedPackageJson) && isRecord(seedPackageJson.dependencies)
        ? seedPackageJson.dependencies
        : {}),
    },
  };
  writeFileSync(
    join(configDir, 'package.json'),
    `${JSON.stringify(mergedPackageJson, null, 2)}\n`,
  );
  if (!isOpenCodePluginSeedComplete(configDir)) {
    throw new Error(
      `Copied the OpenCode plugin seed from ${sourceDir} into ${configDir}, but the result is still incomplete.`,
    );
  }
  return 'copied';
}

const OPENCODE_NPM_CONFIG_FILE = '.npmrc';

/**
 * npm settings OpenCode's own Arborist install reads from the directory it
 * installs into. They only matter when the seed is absent or stale (local
 * development, or an OpenCode bump shipped without a rebuilt seed): npm's
 * defaults wait 300s for a stalled registry response and retry twice, which
 * is what turned a missing seed into a five-minute dead Fast turn. Prefer
 * the local cache, give up on a stalled request in 15s, and retry once, so
 * the fallback install costs seconds. Measured locally with OpenCode 1.18.10
 * against an unseeded global config dir: 500s without this file, 3s with it.
 */
export const OPENCODE_NPM_CONFIG_CONTENT = [
  'prefer-offline=true',
  'fetch-timeout=15000',
  'fetch-retries=1',
  'audit=false',
  'fund=false',
  '',
].join('\n');

/**
 * Writes the bounded npm settings into `configDir` unless the directory
 * already carries its own `.npmrc`, which is left alone as operator intent.
 */
export function writeOpenCodeNpmConfigIfMissing(configDir: string): boolean {
  const target = join(configDir, OPENCODE_NPM_CONFIG_FILE);
  if (existsSync(target)) return false;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(target, OPENCODE_NPM_CONFIG_CONTENT);
  return true;
}

/**
 * Seeds every directory OpenCode would install into for a server spawned
 * with `env`, and bounds the install OpenCode runs itself wherever the seed
 * does not apply.
 */
export function seedOpenCodePluginDependenciesForEnv(
  env: NodeJS.ProcessEnv,
): Record<string, OpenCodePluginSeedResult> {
  const results: Record<string, OpenCodePluginSeedResult> = {};
  for (const dir of resolveOpenCodePluginInstallDirs(env)) {
    writeOpenCodeNpmConfigIfMissing(dir);
    results[dir] = seedOpenCodePluginDependencies(dir, env);
  }
  return results;
}
