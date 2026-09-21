import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { expect, it } from 'vitest';

import type { EnvironmentRecipe } from '@roomote/types';

import { rBioconductorWorkerAdapter } from './r-bioconductor';

it(
  'resolves and cleanly restores a Bioconductor package closure that reuses image libraries',
  async () => {
    const recipePath = await mkdtemp(
      join(tmpdir(), 'roomote-r-bioconductor-recipe-'),
    );
    const recipe: EnvironmentRecipe = {
      type: 'r-bioconductor',
      schema_version: 1,
      request: { packages: ['DESeq2', 'airway'] },
      request_fingerprint: 'a'.repeat(64),
    };

    try {
      const commands = rBioconductorWorkerAdapter.buildResolutionCommands({
        recipe,
        recipePath,
      });

      for (const command of commands) {
        await execa('sh', ['-c', command.run], {
          stdio: 'inherit',
          timeout: command.timeout ? command.timeout * 1_000 : undefined,
        });
      }

      const lock = JSON.parse(
        await readFile(join(recipePath, 'renv.lock'), 'utf8'),
      ) as {
        Bioconductor?: { Version?: string };
        Packages?: Record<string, unknown>;
      };

      expect(lock.Bioconductor?.Version).toBe('3.21');
      expect(Object.keys(lock.Packages ?? {})).toEqual(
        expect.arrayContaining([
          'airway',
          'BiocManager',
          'BiocVersion',
          'cli',
          'DESeq2',
          'Matrix',
          'generics',
          'renv',
        ]),
      );
    } finally {
      await rm(recipePath, { recursive: true, force: true });
    }
  },
  20 * 60 * 1_000,
);
