import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  computeResolutionFingerprint,
  type EnvironmentRecipeWorkerAdapter,
} from './common';

const R_BIOCONDUCTOR_RECIPE_IMAGE =
  'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb' as const;
const R_BIOCONDUCTOR_RECIPE_R_VERSION = '4.5.2' as const;
const R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION = '3.21' as const;

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function packageProbe(packages: string[]): string {
  return [
    `pkgs <- ${rVector(packages)}`,
    'paths <- vapply(pkgs, function(pkg) find.package(pkg, lib.loc=target), character(1))',
    'stopifnot(all(startsWith(normalizePath(paths), paste0(target, .Platform$file.sep))))',
    'invisible(lapply(pkgs, function(pkg) loadNamespace(pkg, lib.loc=target)))',
  ].join(';');
}

function rVector(values: string[]): string {
  return `c(${values.map((value) => JSON.stringify(value)).join(',')})`;
}

/**
 * Resolve the R and Bioconductor versions against the pinned constants and
 * reject any image that drifts.
 */
function pinnedRuntimeAssertions(): string[] {
  return [
    `stopifnot(R.version$major == 4, R.version$minor == "5.2")`,
    `library('BiocManager'); stopifnot(BiocManager::version() == ${JSON.stringify(R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION)})`,
  ];
}

/**
 * Resolve an unresolved recipe request from the official CRAN and
 * Bioconductor repositories inside the pinned image with an empty library:
 * install through BiocManager under the pinned Bioconductor release, validate
 * the installation, snapshot the complete closure into renv.lock, and emit
 * direct-package metadata with real repository provenance. GitHub remotes,
 * local packages, private registries, and dynamically computed package names
 * are out of scope and surface as actionable failures.
 */
function buildResolveScript(packages: string[]): string {
  return [
    ...pinnedRuntimeAssertions(),
    ...recipeLibrarySetup(),
    "options(repos=c(CRAN='https://cloud.r-project.org'))",
    `options(BIOCONDUCTOR_VERSION=${JSON.stringify(R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION)})`,
    "if (!nzchar(system.file(package='BiocManager', lib.loc=target))) install.packages('BiocManager', lib=target)",
    'biocAvailable <- BiocManager::available()',
    'cranAvailable <- rownames(utils::available.packages())',
    `pkgs <- ${rVector(packages)}`,
    "BiocManager::install(unique(c('BiocVersion', pkgs)), lib=target, ask=FALSE, update=FALSE, force=TRUE)",
    'validation <- BiocManager::valid(lib.loc=target)',
    'if (!isTRUE(validation)) { print(validation); if (length(validation) > 0) quit(status=1) }',
    'lines <- vapply(pkgs, function(pkg) { desc <- utils::packageDescription(pkg, lib.loc=target); repo <- if (pkg %in% cranAvailable) "cran" else if (pkg %in% biocAvailable) "bioconductor" else NA; if (is.na(repo)) { message(paste("unsupported package source for", pkg)); quit(status=1) }; paste(pkg, desc$Version, repo, sep="\t") }, character(1))',
    "writeLines(lines, '/roomote-recipe/direct-packages.tsv')",
    "if (!nzchar(system.file(package='renv', lib.loc=target))) install.packages('renv', lib=target)",
    `renv::settings$bioconductor.version(${JSON.stringify(R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION)}, project='/roomote-recipe')`,
    "renv::snapshot(project='/roomote-recipe', type='all', library=target, lockfile='/roomote-recipe/renv.lock', prompt=FALSE)",
  ].join(';');
}

/**
 * Put the mounted recipe library first while retaining R's base/site
 * libraries for runtime and bootstrap tooling. Direct packages are installed,
 * snapshotted, and probed explicitly from `target`, so a package preinstalled
 * in the image cannot masquerade as part of the recipe resolution.
 */
function recipeLibrarySetup(): string[] {
  return [
    "target <- normalizePath('/roomote-recipe/library')",
    '.libPaths(c(target, .libPaths()))',
    'stopifnot(normalizePath(.libPaths()[[1]]) == target)',
  ];
}

export const rBioconductorWorkerAdapter: EnvironmentRecipeWorkerAdapter = {
  type: 'r-bioconductor',
  setupPlanName: 'r-bioconductor',

  buildResolutionCommands({ recipe, recipePath }) {
    const image = shellEscape(R_BIOCONDUCTOR_RECIPE_IMAGE);
    const recipeMount = `${shellEscape(recipePath)}:/roomote-recipe`;
    const packages = recipe.request.packages;

    return [
      {
        name: 'Pull pinned R/Bioconductor runtime',
        run: `docker pull ${image}`,
        timeout: 1800,
        continue_on_error: false,
      },
      {
        name: 'Resolve requested R packages from CRAN/Bioconductor',
        run: `mkdir -p ${shellEscape(join(recipePath, 'library'))} && docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape(buildResolveScript(packages))}`,
        timeout: 7200,
        continue_on_error: false,
      },
      {
        name: 'Erase resolved library and cleanly restore from lock',
        run: `rm -rf ${shellEscape(join(recipePath, 'library'))} && mkdir -p ${shellEscape(join(recipePath, 'library'))} && docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape([...pinnedRuntimeAssertions(), ...recipeLibrarySetup(), "options(repos=c(CRAN='https://cloud.r-project.org'))", "if (!requireNamespace('renv', quietly=TRUE)) install.packages('renv', lib=target)", "renv::restore(lockfile='/roomote-recipe/renv.lock', library=target, prompt=FALSE)"].join(';'))}`,
        timeout: 3600,
        continue_on_error: false,
      },
      {
        name: 'Load every directly requested R package',
        run: `docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape([...pinnedRuntimeAssertions(), ...recipeLibrarySetup(), packageProbe(packages)].join(';'))}`,
        timeout: 600,
        continue_on_error: false,
      },
    ] as const;
  },

  buildRestoreCommands({ recipe, recipePath }) {
    const resolution = recipe.resolution;
    if (!resolution) {
      return [];
    }
    const image = shellEscape(resolution.image);
    const recipeMount = `${shellEscape(recipePath)}:/roomote-recipe`;
    const packages = recipe.request.packages;

    return [
      {
        name: 'Pull pinned R/Bioconductor runtime',
        run: `docker pull ${image}`,
        timeout: 1800,
        continue_on_error: false,
      },
      {
        name: 'Restore pinned R packages',
        run: `mkdir -p ${shellEscape(join(recipePath, 'library'))} && docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape([...pinnedRuntimeAssertions(), ...recipeLibrarySetup(), "options(repos=c(CRAN='https://cloud.r-project.org'))", "if (!requireNamespace('renv', quietly=TRUE)) install.packages('renv', lib=target)", "renv::restore(lockfile='/roomote-recipe/renv.lock', library=target, prompt=FALSE)"].join(';'))}`,
        timeout: 3600,
        continue_on_error: false,
      },
      {
        name: 'Verify pinned R packages',
        run: `docker run --rm -e R_LIBS_USER=/roomote-recipe/library -v ${recipeMount} ${image} Rscript -e ${shellEscape([...pinnedRuntimeAssertions(), ...recipeLibrarySetup(), packageProbe(packages)].join(';'))}`,
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
  },

  async readResolvedRecipe({ recipe, recipePath }) {
    const [metaLines, lockJson] = await Promise.all([
      readFile(join(recipePath, 'direct-packages.tsv'), 'utf8').catch(
        () => null,
      ),
      readFile(join(recipePath, 'renv.lock'), 'utf8').catch(() => null),
    ]);

    if (!metaLines || !lockJson) {
      return null;
    }

    let lock: Record<string, unknown>;
    try {
      lock = JSON.parse(lockJson) as Record<string, unknown>;
    } catch {
      return null;
    }

    const packages = metaLines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, version, repository] = line.split('\t');
        return {
          name: name ?? '',
          version: version ?? '',
          repository: repository === 'bioconductor' ? 'bioconductor' : 'cran',
        } as const;
      });

    if (packages.length === 0) {
      return null;
    }

    const resolution = {
      image: R_BIOCONDUCTOR_RECIPE_IMAGE,
      r_version: R_BIOCONDUCTOR_RECIPE_R_VERSION,
      bioconductor_version: R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
      packages,
      renv_lock: lock,
    };

    return {
      ...recipe,
      resolution: {
        ...resolution,
        resolution_fingerprint: computeResolutionFingerprint(resolution),
      },
    };
  },

  async materializeResolution({ recipe, recipePath }) {
    const resolution = recipe.resolution;
    if (!resolution) {
      throw new Error('Cannot materialize an unresolved R recipe.');
    }
    await writeFile(
      join(recipePath, 'renv.lock'),
      `${JSON.stringify(resolution.renv_lock, null, 2)}\n`,
      'utf8',
    );
  },

  async afterRestore({ recipe, recipePath, workspacePath }) {
    const resolution = recipe.resolution;
    if (!resolution) {
      return;
    }
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(workspacePath, '.roomote'), { recursive: true });
    await writeFile(
      join(workspacePath, '.roomote', 'environment-recipe.json'),
      JSON.stringify(
        {
          type: recipe.type,
          image: resolution.image,
          rVersion: resolution.r_version,
          bioconductorVersion: resolution.bioconductor_version,
          directPackages: recipe.request.packages,
          lockfile: join(recipePath, 'renv.lock'),
        },
        null,
        2,
      ),
      'utf8',
    );

    const wrapper = `#!/usr/bin/env bash
set -euo pipefail
docker run --rm \
  -e R_LIBS_USER=/roomote-recipe/library \
  -v ${shellEscape(recipePath)}:/roomote-recipe:ro \
  -v ${shellEscape(workspacePath)}:${workspacePath} \
  -w "$PWD" \
  ${shellEscape(resolution.image)} Rscript "$@"
`;
    await writeFile(join(workspacePath, 'roomote-rscript'), wrapper, {
      encoding: 'utf8',
      mode: 0o755,
    });
  },
};
