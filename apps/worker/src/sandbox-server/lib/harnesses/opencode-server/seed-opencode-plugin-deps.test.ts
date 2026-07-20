import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isOpenCodePluginSeedComplete,
  seedOpenCodePluginDependencies,
  writeOpenCodePluginSeedFixture,
} from './seed-opencode-plugin-deps';

describe('seedOpenCodePluginDependencies', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createLogger() {
    return {
      runId: 1,
      filePath: '/tmp/test.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports complete when package.json, lock, and installed plugin match version', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-');
    writeOpenCodePluginSeedFixture({ configDir, version: '1.17.18' });

    await expect(
      isOpenCodePluginSeedComplete({ configDir, version: '1.17.18' }),
    ).resolves.toBe(true);
    await expect(
      isOpenCodePluginSeedComplete({ configDir, version: '1.18.0' }),
    ).resolves.toBe(false);
  });

  it('no-ops when the config dir seed is already complete', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-');
    writeOpenCodePluginSeedFixture({ configDir, version: '1.17.18' });
    const install = vi.fn();

    await expect(
      seedOpenCodePluginDependencies({
        configDir,
        version: '1.17.18',
        logger: createLogger(),
        install,
        seedDirs: [],
      }),
    ).resolves.toBe('already-complete');
    expect(install).not.toHaveBeenCalled();
  });

  it('copies a complete baked seed into the config dir', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-target-');
    const seedDir = createTempDir('roomote-opencode-plugin-seed-source-');
    writeOpenCodePluginSeedFixture({ configDir: seedDir, version: '1.17.18' });
    const install = vi.fn();

    await expect(
      seedOpenCodePluginDependencies({
        configDir,
        version: '1.17.18',
        logger: createLogger(),
        install,
        seedDirs: [seedDir],
      }),
    ).resolves.toBe('copied');
    expect(install).not.toHaveBeenCalled();
    await expect(
      isOpenCodePluginSeedComplete({ configDir, version: '1.17.18' }),
    ).resolves.toBe(true);
  });

  it('installs when no complete seed exists and verifies the result', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-target-');
    const install = vi.fn(async (options: { configDir: string }) => {
      writeOpenCodePluginSeedFixture({
        configDir: options.configDir,
        version: '1.17.18',
      });
    });

    await expect(
      seedOpenCodePluginDependencies({
        configDir,
        version: '1.17.18',
        logger: createLogger(),
        install,
        seedDirs: [],
      }),
    ).resolves.toBe('installed');
    expect(install).toHaveBeenCalledTimes(1);
    await expect(
      isOpenCodePluginSeedComplete({ configDir, version: '1.17.18' }),
    ).resolves.toBe(true);
  });

  it('fails closed when install leaves an incomplete seed', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-target-');
    const install = vi.fn(async () => {
      // Intentionally incomplete.
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(configDir, 'package.json'),
        '{"name":"opencode"}\n',
      );
    });

    await expect(
      seedOpenCodePluginDependencies({
        configDir,
        version: '1.17.18',
        logger: createLogger(),
        install,
        seedDirs: [],
      }),
    ).rejects.toThrow(/still incomplete/i);
  });

  it('fails closed when the install itself throws', async () => {
    const configDir = createTempDir('roomote-opencode-plugin-seed-target-');
    const install = vi.fn(async () => {
      throw new Error('registry timeout');
    });

    await expect(
      seedOpenCodePluginDependencies({
        configDir,
        version: '1.17.18',
        logger: createLogger(),
        install,
        seedDirs: [],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Failed to install OpenCode plugin seed/);
  });
});
