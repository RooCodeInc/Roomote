import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeOpenCodePluginSeedFixture } from './helpers/opencode-plugin-seed-fixture';
import {
  isOpenCodePluginSeedComplete,
  OPENCODE_PLUGIN_SEED_DIR_ENV,
  resolveOpenCodePluginInstallDirs,
  seedOpenCodePluginDependencies,
  seedOpenCodePluginDependenciesForEnv,
} from '../opencode-plugin-seed';

describe('OpenCode plugin seed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'opencode-plugin-seed-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('recognises a complete seed and rejects incomplete or stale ones', () => {
    const complete = path.join(root, 'complete');
    writeOpenCodePluginSeedFixture(complete, '1.18.10');
    expect(isOpenCodePluginSeedComplete(complete)).toBe(true);

    const bareDir = path.join(root, 'bare');
    mkdirSync(bareDir);
    writeFileSync(
      path.join(bareDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    expect(isOpenCodePluginSeedComplete(bareDir)).toBe(false);

    const unlocked = path.join(root, 'unlocked');
    writeOpenCodePluginSeedFixture(unlocked, '1.18.10', {
      lockRootDependencies: [],
    });
    expect(isOpenCodePluginSeedComplete(unlocked)).toBe(false);

    const stale = path.join(root, 'stale');
    writeOpenCodePluginSeedFixture(stale, '1.18.10', {
      installedVersion: '1.17.0',
    });
    expect(isOpenCodePluginSeedComplete(stale)).toBe(false);
  });

  it('copies the baked seed into a config directory once', () => {
    const seedDir = path.join(root, 'seed');
    writeOpenCodePluginSeedFixture(seedDir, '1.18.10');
    const configDir = path.join(root, 'config', 'opencode');
    const env = { [OPENCODE_PLUGIN_SEED_DIR_ENV]: seedDir };

    expect(seedOpenCodePluginDependencies(configDir, env)).toBe('copied');
    expect(isOpenCodePluginSeedComplete(configDir)).toBe(true);
    expect(
      readFileSync(
        path.join(
          configDir,
          'node_modules',
          '@opencode-ai',
          'plugin',
          'index.js',
        ),
        'utf8',
      ),
    ).toBe('export {};\n');
    expect(seedOpenCodePluginDependencies(configDir, env)).toBe(
      'already-complete',
    );
  });

  it('keeps a bare shared tools directory intact when copying into it', () => {
    const seedDir = path.join(root, 'seed');
    writeOpenCodePluginSeedFixture(seedDir, '1.18.10');
    const configDir = path.join(root, 'shared-tools');
    mkdirSync(path.join(configDir, 'tools'), { recursive: true });
    writeFileSync(path.join(configDir, 'tools', 'send_chat_reply.js'), 'tool');
    writeFileSync(
      path.join(configDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );

    expect(
      seedOpenCodePluginDependencies(configDir, {
        [OPENCODE_PLUGIN_SEED_DIR_ENV]: seedDir,
      }),
    ).toBe('copied');
    // The ESM tool files depend on `type: "module"` surviving the seed; only
    // the dependency declarations come from the baked package.json.
    expect(
      JSON.parse(readFileSync(path.join(configDir, 'package.json'), 'utf8')),
    ).toEqual({
      private: true,
      type: 'module',
      dependencies: { '@opencode-ai/plugin': '1.18.10' },
    });
    expect(
      readFileSync(path.join(configDir, 'tools', 'send_chat_reply.js'), 'utf8'),
    ).toBe('tool');
    expect(isOpenCodePluginSeedComplete(configDir)).toBe(true);
    expect(
      seedOpenCodePluginDependencies(configDir, {
        [OPENCODE_PLUGIN_SEED_DIR_ENV]: seedDir,
      }),
    ).toBe('already-complete');
  });

  it('leaves the directory alone when no usable seed is baked', () => {
    const configDir = path.join(root, 'config', 'opencode');
    expect(
      seedOpenCodePluginDependencies(configDir, {
        [OPENCODE_PLUGIN_SEED_DIR_ENV]: path.join(root, 'missing'),
      }),
    ).toBe('no-seed');
    expect(existsSync(configDir)).toBe(false);

    const incompleteSeed = path.join(root, 'incomplete-seed');
    mkdirSync(incompleteSeed);
    writeFileSync(path.join(incompleteSeed, 'package.json'), '{}');
    expect(
      seedOpenCodePluginDependencies(configDir, {
        [OPENCODE_PLUGIN_SEED_DIR_ENV]: incompleteSeed,
      }),
    ).toBe('no-seed');
    expect(existsSync(configDir)).toBe(false);
  });

  it('seeds both the XDG global config dir and OPENCODE_CONFIG_DIR for a server env', () => {
    const seedDir = path.join(root, 'seed');
    writeOpenCodePluginSeedFixture(seedDir, '1.18.10');
    const home = path.join(root, 'home');
    const sharedTools = path.join(root, 'shared-tools');
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCODE_CONFIG_DIR: sharedTools,
      [OPENCODE_PLUGIN_SEED_DIR_ENV]: seedDir,
    };

    expect(resolveOpenCodePluginInstallDirs(env)).toEqual([
      sharedTools,
      path.join(home, '.config', 'opencode'),
    ]);
    expect(
      resolveOpenCodePluginInstallDirs({
        HOME: home,
        XDG_CONFIG_HOME: path.join(root, 'xdg'),
      }),
    ).toEqual([path.join(root, 'xdg', 'opencode')]);

    expect(seedOpenCodePluginDependenciesForEnv(env)).toEqual({
      [sharedTools]: 'copied',
      [path.join(home, '.config', 'opencode')]: 'copied',
    });
    expect(isOpenCodePluginSeedComplete(sharedTools)).toBe(true);
    expect(
      isOpenCodePluginSeedComplete(path.join(home, '.config', 'opencode')),
    ).toBe(true);
  });
});
