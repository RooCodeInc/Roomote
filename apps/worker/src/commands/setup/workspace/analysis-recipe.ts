import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import type { RBioconductorAnalysisRecipe } from '@roomote/types';

import {
  CommandExecutor,
  ExecutionError,
  type ExecutionResult,
} from '../../../command-executor';
import type { StartupLogger } from '../../../logging';

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRAnalysisRecipeCommands(input: {
  recipe: RBioconductorAnalysisRecipe;
  recipePath: string;
}) {
  const { recipe, recipePath } = input;
  const image = shellEscape(recipe.image);
  const recipeMount = `${shellEscape(recipePath)}:/roomote-recipe`;
  const packageProbe = recipe.direct_packages
    .map(
      (pkg) =>
        `stopifnot(requireNamespace(${JSON.stringify(pkg.name)}, quietly=TRUE))`,
    )
    .join(';');

  return [
    {
      name: 'Pull pinned R/Bioconductor runtime',
      run: `docker pull ${image}`,
      timeout: 1800,
      continue_on_error: false,
    },
    {
      name: 'Restore pinned R packages',
      run: `docker run --rm -v ${recipeMount} ${image} Rscript -e ${shellEscape("options(repos=c(CRAN='https://cloud.r-project.org')); if (!requireNamespace('renv', quietly=TRUE)) install.packages('renv'); renv::restore(lockfile='/roomote-recipe/renv.lock', library='/roomote-recipe/library', prompt=FALSE)")}`,
      timeout: 3600,
      continue_on_error: false,
    },
    {
      name: 'Verify pinned R packages',
      run: `docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape(packageProbe)}`,
      timeout: 600,
      continue_on_error: false,
    },
    {
      name: 'Write Roomote R runner',
      run: 'true',
      timeout: 60,
      continue_on_error: false,
    },
  ] as const;
}

export async function setupAnalysisRecipe(
  logger: StartupLogger,
  input: {
    recipe: RBioconductorAnalysisRecipe;
    workspacePath: string;
    envVars: Record<string, string | undefined>;
    onCommandStart?: (name: string) => void;
    onCommandResult?: (result: ExecutionResult) => void;
  },
): Promise<void> {
  const recipeHash = createHash('sha256')
    .update(input.recipe.renv_lock)
    .digest('hex')
    .slice(0, 16);
  const recipePath = join(
    input.workspacePath,
    '.roomote',
    'recipes',
    recipeHash,
  );
  await mkdir(join(recipePath, 'library'), { recursive: true });
  await writeFile(
    join(recipePath, 'renv.lock'),
    input.recipe.renv_lock,
    'utf8',
  );
  await writeFile(
    join(input.workspacePath, '.roomote', 'analysis-recipe.json'),
    JSON.stringify(
      {
        catalogId: input.recipe.catalog_id,
        image: input.recipe.image,
        rVersion: input.recipe.r_version,
        bioconductorVersion: input.recipe.bioconductor_version,
        directPackages: input.recipe.direct_packages,
        lockfile: join(recipePath, 'renv.lock'),
      },
      null,
      2,
    ),
    'utf8',
  );

  const executor = new CommandExecutor(input.workspacePath, input.envVars);
  const commands = buildRAnalysisRecipeCommands({
    recipe: input.recipe,
    recipePath,
  });

  logger.userLog.log('Preparing the pinned R/Bioconductor recipe');
  for (const command of commands.slice(0, -1)) {
    input.onCommandStart?.(command.name);
    try {
      const result = await executor.execute(command);
      input.onCommandResult?.(result);
    } catch (error) {
      if (error instanceof ExecutionError) {
        input.onCommandResult?.(error.result);
      }
      throw error;
    }
  }

  const wrapperPath = join(input.workspacePath, 'roomote-rscript');
  const wrapper = `#!/usr/bin/env bash
set -euo pipefail
docker run --rm \
  -e R_LIBS_USER=/roomote-recipe/library \
  -v ${shellEscape(recipePath)}:/roomote-recipe:ro \
  -v ${shellEscape(input.workspacePath)}:${input.workspacePath} \
  -w "$PWD" \
  ${shellEscape(input.recipe.image)} Rscript "$@"
`;
  await writeFile(wrapperPath, wrapper, { encoding: 'utf8', mode: 0o755 });
}
