import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from '@roomote/types';

import { computeResolutionFingerprint } from './common';
import { rBioconductorWorkerAdapter } from './r-bioconductor';
import { getRecipeWorkerAdapter } from './registry';

function decodeShell(value: string): string {
  return value.replaceAll("'\\''", "'");
}

const unresolvedRecipe: EnvironmentRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2', 'airway'] },
  request_fingerprint: 'a'.repeat(64),
};

const resolvedRecipe: EnvironmentRecipe = {
  ...unresolvedRecipe,
  resolution: {
    image:
      'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb',
    r_version: '4.5.2',
    bioconductor_version: '3.21',
    packages: [
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
      { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
    ],
    renv_lock: {
      R: { Version: '4.5.2' },
      Bioconductor: { Version: '3.21' },
      Packages: { DESeq2: {}, airway: {} },
    },
    resolution_fingerprint: 'b'.repeat(64),
  },
};

describe('worker recipe registry', () => {
  it('registers only the r-bioconductor adapter', () => {
    expect(getRecipeWorkerAdapter('r-bioconductor')).toBe(
      rBioconductorWorkerAdapter,
    );
  });

  it('resolution commands resolve from official repositories, erase the library, restore from the lock, and load direct packages', () => {
    const commands = rBioconductorWorkerAdapter.buildResolutionCommands({
      recipe: unresolvedRecipe,
      recipePath: '/tmp/recipe',
    });
    const runs = commands.map((command) => command.run).join('\n');
    expect(runs).toContain('BiocManager::install');
    expect(decodeShell(runs)).toContain(
      "renv::snapshot(project='/roomote-recipe'",
    );
    expect(runs).toContain('rm -rf');
    expect(runs).toContain('renv::restore(lockfile');
    expect(runs).toContain('find.package(pkg, lib.loc=target)');
    expect(runs).toContain('loadNamespace(pkg, lib.loc=target)');
    expect(commands.some((command) => command.timeout! >= 3600)).toBe(true);
  });

  it('resolution commands assert pinned runtime and isolate recipe packages without rejecting R system libraries', () => {
    const commands = rBioconductorWorkerAdapter.buildResolutionCommands({
      recipe: unresolvedRecipe,
      recipePath: '/tmp/recipe',
    });
    const scripts = commands.map((command) => decodeShell(command.run));
    for (const script of scripts.slice(1)) {
      expect(script).toContain('R.version$major == 4, R.version$minor');
      expect(script).toContain('BiocManager::version()');
      expect(script).toContain('.libPaths(c(target, .libPaths()))');
      expect(script).not.toContain('unexpected library path');
    }
    expect(scripts[1]).toContain(
      "system.file(package='BiocManager', lib.loc=target)",
    );
    expect(scripts[1]).toContain(
      "BiocManager::install(unique(c('BiocVersion', pkgs)), lib=target",
    );
    expect(scripts[1]).toContain("system.file(package='renv', lib.loc=target)");
    expect(scripts[1]).toContain(
      'settings$bioconductor.version("3.21", project=\'/roomote-recipe\')',
    );
    expect(scripts[1]).toContain("type='all', library=target");
  });

  it('labels CRAN provenance before Bioconductor and fails unsupported sources', () => {
    const commands = rBioconductorWorkerAdapter.buildResolutionCommands({
      recipe: unresolvedRecipe,
      recipePath: '/tmp/recipe',
    });
    const script = decodeShell(commands[1]!.run);
    expect(script).toContain(
      'cranAvailable <- rownames(utils::available.packages())',
    );
    expect(script).toContain('biocAvailable <- BiocManager::available()');
    expect(script).toContain('pkg %in% cranAvailable');
    expect(script).toContain('unsupported package source');
  });

  it('reads a resolved recipe with a CRAN-only direct package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roomote-recipe-'));
    await writeFile(
      join(dir, 'direct-packages.tsv'),
      'tximeta\t1.26.0\tbioconductor\nsyntact\t1.2.3\tcran\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'renv.lock'),
      JSON.stringify({
        R: { Version: '4.5.2' },
        Bioconductor: { Version: '3.21' },
        Packages: { tximeta: {}, syntact: {} },
      }),
      'utf8',
    );

    const resolved = await rBioconductorWorkerAdapter.readResolvedRecipe({
      recipe: unresolvedRecipe,
      recipePath: dir,
    });

    expect(resolved?.resolution?.packages).toEqual([
      { name: 'tximeta', version: '1.26.0', repository: 'bioconductor' },
      { name: 'syntact', version: '1.2.3', repository: 'cran' },
    ]);
  });

  it('restore commands never rerun dependency resolution for resolved recipes', () => {
    const commands = rBioconductorWorkerAdapter.buildRestoreCommands({
      recipe: resolvedRecipe,
      recipePath: '/tmp/recipe',
    });
    const runs = commands.map((command) => command.run).join('\n');
    expect(decodeShell(runs)).toContain('renv::restore(lockfile');
    expect(decodeShell(runs)).not.toContain('BiocManager::install');
    expect(decodeShell(runs)).not.toContain('renv::snapshot(');
  });

  it('materializes the persisted lock into a fresh recipe workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roomote-recipe-'));

    await rBioconductorWorkerAdapter.materializeResolution?.({
      recipe: resolvedRecipe,
      recipePath: dir,
    });

    await expect(readFile(join(dir, 'renv.lock'), 'utf8')).resolves.toBe(
      `${JSON.stringify(resolvedRecipe.resolution!.renv_lock, null, 2)}\n`,
    );
  });

  it('restore commands are empty for unresolved recipes', () => {
    expect(
      rBioconductorWorkerAdapter.buildRestoreCommands({
        recipe: unresolvedRecipe,
        recipePath: '/tmp/recipe',
      }),
    ).toEqual([]);
  });

  it('reads a resolved recipe from resolution artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roomote-recipe-'));
    await writeFile(
      join(dir, 'direct-packages.tsv'),
      'DESeq2\t1.48.2\tbioconductor\nairway\t1.28.0\tbioconductor\n',
      'utf8',
    );
    const lock = {
      R: { Version: '4.5.2' },
      Bioconductor: { Version: '3.21' },
      Packages: { DESeq2: {}, airway: {} },
    };
    await writeFile(join(dir, 'renv.lock'), JSON.stringify(lock), 'utf8');

    const resolved = await rBioconductorWorkerAdapter.readResolvedRecipe({
      recipe: unresolvedRecipe,
      recipePath: dir,
    });

    expect(resolved?.resolution).toBeTruthy();
    expect(resolved?.resolution?.packages).toEqual([
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
      { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
    ]);
    const image = resolved!.resolution!.image;
    expect(image).toBe(
      'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb',
    );
    expect(resolved?.resolution?.resolution_fingerprint).toBe(
      computeResolutionFingerprint({
        image,
        r_version: '4.5.2',
        bioconductor_version: '3.21',
        packages: [
          { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
          { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
        ],
        renv_lock: lock,
      }),
    );
  });

  it('never persists a partial resolution when artifacts are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roomote-recipe-'));
    const resolved = await rBioconductorWorkerAdapter.readResolvedRecipe({
      recipe: unresolvedRecipe,
      recipePath: dir,
    });
    expect(resolved).toBeNull();
  });
});
