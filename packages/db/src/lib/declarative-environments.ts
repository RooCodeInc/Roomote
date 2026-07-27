import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { EnvironmentConfig } from '@roomote/types';
import {
  environmentConfigSchema,
  getEnvironmentRepositoryConnectionError,
  getMissingEnvironmentRepositoryError,
} from '@roomote/types';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import YAML from 'yaml';

import { db } from '../db';
import {
  environmentRepositoryMappings,
  environments,
  repositories,
} from '../schema';
import { createEnvironmentConfigVersionSnapshot } from './environment-config-versions';
import { updateEnvironmentDefinition } from './environment-definitions';

/**
 * Declarative environment provisioning.
 *
 * Operators can supply environment definitions at startup instead of creating
 * them through the web UI or the environment-setup agent:
 *
 * - `ROOMOTE_ENVIRONMENTS_DIR` points at a directory of YAML/JSON files, one
 *   environment definition per file (the same format the web YAML editor and
 *   the `manage_environments` MCP tool accept).
 * - `ROOMOTE_ENVIRONMENTS_YAML` carries one or more inline YAML documents
 *   (separated by `---`) for platforms where mounting files is awkward.
 *
 * The API boot sequence applies the combined set idempotently: create missing
 * environments, update existing ones (the declarative definition wins over
 * later UI/agent edits on every boot), and never delete. Environments whose
 * definition disappears from the set are "orphaned" back to normal manual
 * management by clearing `environments.declarative_source`.
 */

const DECLARATIVE_ENVIRONMENTS_DIR_ENV_VAR = 'ROOMOTE_ENVIRONMENTS_DIR';
const DECLARATIVE_ENVIRONMENTS_YAML_ENV_VAR = 'ROOMOTE_ENVIRONMENTS_YAML';

const SUPPORTED_FILE_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

// Same bounded backoff the auth-keypair bootstrap uses so the API can boot in
// parallel with the db-migrate pre-deploy step on fresh deployments (~90s).
const DEFAULT_MIGRATION_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
];

const MISSING_RELATION_PG_CODE = '42P01';

const UNIQUE_VIOLATION_CODE = '23505';
const ENVIRONMENT_NAME_UNIQUE_CONSTRAINT = 'environments_name_unique';

/**
 * Whether the error (or anything in its cause chain — drizzle wraps the
 * driver error in a DrizzleQueryError) is Postgres 42P01 "relation does not
 * exist", i.e. the `environments` table has not been migrated yet.
 */
function isMissingRelationError(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 10;
    depth += 1
  ) {
    if ((current as { code?: unknown }).code === MISSING_RELATION_PG_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

function isEnvironmentNameUniqueViolation(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 10;
    depth += 1
  ) {
    const dbError = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };

    if (
      dbError.code === UNIQUE_VIOLATION_CODE &&
      (dbError.constraint === ENVIRONMENT_NAME_UNIQUE_CONSTRAINT ||
        (typeof dbError.message === 'string' &&
          dbError.message.includes(ENVIRONMENT_NAME_UNIQUE_CONSTRAINT)))
    ) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

export type DeclarativeEnvironmentDefinition = {
  /** Human-readable provenance: file basename or `env:<document index>`. */
  source: string;
  config: EnvironmentConfig;
};

export type DeclarativeEnvironmentSkip = {
  source: string;
  reason: string;
};

export type DeclarativeEnvironmentsSummary = {
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: DeclarativeEnvironmentSkip[];
  /** Environment names whose declarative marker was cleared this run. */
  orphaned: string[];
  /**
   * True when orphan reconciliation was deferred because part of the declared
   * set could not be read or validated, so the full set of declared names was
   * unknown. Existing declarative markers are left untouched in that case.
   */
  orphaningDeferred: boolean;
};

type ParsedDefinitions = {
  definitions: DeclarativeEnvironmentDefinition[];
  skipped: DeclarativeEnvironmentSkip[];
  /**
   * True when a source failed to read, parse, or validate, meaning the names
   * it declares are unknown. Orphan reconciliation must be skipped then, so a
   * transient typo in a still-present definition does not clear its
   * environment's declarative marker.
   */
  hasUnresolvedNames: boolean;
};

function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateDefinition(
  source: string,
  raw: unknown,
):
  | { definition: DeclarativeEnvironmentDefinition }
  | { skip: DeclarativeEnvironmentSkip } {
  const parsed = environmentConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');

    return {
      skip: { source, reason: `Invalid environment configuration: ${issues}` },
    };
  }

  return { definition: { source, config: parsed.data } };
}

async function readDefinitionsFromDir(dir: string): Promise<ParsedDefinitions> {
  const definitions: DeclarativeEnvironmentDefinition[] = [];
  const skipped: DeclarativeEnvironmentSkip[] = [];
  let hasUnresolvedNames = false;

  let fileNames: string[];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    fileNames = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          SUPPORTED_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => entry.name)
      // Bytewise comparison keeps duplicate-name precedence deterministic
      // across locales.
      .sort();
  } catch (error) {
    // A missing or unreadable directory must not abort the whole declarative
    // apply: inline YAML definitions still deserve to be applied. The names
    // the directory declares are unknown, so orphan reconciliation is
    // deferred via hasUnresolvedNames.
    return {
      definitions,
      skipped: [
        {
          source: DECLARATIVE_ENVIRONMENTS_DIR_ENV_VAR,
          reason: `Failed to read directory "${dir}": ${describeParseError(error)}`,
        },
      ],
      hasUnresolvedNames: true,
    };
  }

  for (const fileName of fileNames) {
    let raw: unknown;

    try {
      const content = await readFile(path.join(dir, fileName), 'utf8');
      raw =
        path.extname(fileName).toLowerCase() === '.json'
          ? JSON.parse(content)
          : YAML.parse(content);
    } catch (error) {
      skipped.push({
        source: fileName,
        reason: `Failed to parse: ${describeParseError(error)}`,
      });
      hasUnresolvedNames = true;
      continue;
    }

    const result = validateDefinition(fileName, raw);

    if ('skip' in result) {
      skipped.push(result.skip);
      hasUnresolvedNames = true;
    } else {
      definitions.push(result.definition);
    }
  }

  return { definitions, skipped, hasUnresolvedNames };
}

function readDefinitionsFromInlineYaml(inlineYaml: string): ParsedDefinitions {
  const definitions: DeclarativeEnvironmentDefinition[] = [];
  const skipped: DeclarativeEnvironmentSkip[] = [];
  let hasUnresolvedNames = false;

  let documents: ReturnType<typeof YAML.parseAllDocuments>;

  try {
    documents = YAML.parseAllDocuments(inlineYaml);
  } catch (error) {
    return {
      definitions,
      skipped: [
        {
          source: DECLARATIVE_ENVIRONMENTS_YAML_ENV_VAR,
          reason: `Failed to parse: ${describeParseError(error)}`,
        },
      ],
      hasUnresolvedNames: true,
    };
  }

  documents.forEach((document, index) => {
    const source = `env:${index + 1}`;

    if (document.errors.length > 0) {
      skipped.push({
        source,
        reason: `Failed to parse: ${document.errors
          .map((error) => error.message)
          .join('; ')}`,
      });
      hasUnresolvedNames = true;
      return;
    }

    const raw: unknown = document.toJS();

    if (raw === null || raw === undefined) {
      // Empty documents (for example a trailing `---`) are ignored.
      return;
    }

    const result = validateDefinition(source, raw);

    if ('skip' in result) {
      skipped.push(result.skip);
      hasUnresolvedNames = true;
    } else {
      definitions.push(result.definition);
    }
  });

  return { definitions, skipped, hasUnresolvedNames };
}

function dedupeByName(parsed: ParsedDefinitions): ParsedDefinitions {
  const seenBySource = new Map<string, string>();
  const definitions: DeclarativeEnvironmentDefinition[] = [];
  const skipped = [...parsed.skipped];

  for (const definition of parsed.definitions) {
    const existingSource = seenBySource.get(definition.config.name);

    if (existingSource) {
      // Duplicate names are skipped but their name is known, so they do not
      // block orphan reconciliation.
      skipped.push({
        source: definition.source,
        reason:
          `Duplicate environment name "${definition.config.name}" ` +
          `(already defined by ${existingSource}).`,
      });
      continue;
    }

    seenBySource.set(definition.config.name, definition.source);
    definitions.push(definition);
  }

  return {
    definitions,
    skipped,
    hasUnresolvedNames: parsed.hasUnresolvedNames,
  };
}

/**
 * Read and validate the combined declarative definition set: directory files
 * in lexicographic order first, then inline YAML documents in order. On
 * duplicate names the first definition wins.
 */
export async function readDeclarativeEnvironmentDefinitions(options: {
  dir?: string;
  inlineYaml?: string;
}): Promise<ParsedDefinitions> {
  const definitions: DeclarativeEnvironmentDefinition[] = [];
  const skipped: DeclarativeEnvironmentSkip[] = [];
  let hasUnresolvedNames = false;

  if (options.dir) {
    const fromDir = await readDefinitionsFromDir(options.dir);
    definitions.push(...fromDir.definitions);
    skipped.push(...fromDir.skipped);
    hasUnresolvedNames ||= fromDir.hasUnresolvedNames;
  }

  if (options.inlineYaml?.trim()) {
    const fromInline = readDefinitionsFromInlineYaml(options.inlineYaml);
    definitions.push(...fromInline.definitions);
    skipped.push(...fromInline.skipped);
    hasUnresolvedNames ||= fromInline.hasUnresolvedNames;
  }

  return dedupeByName({ definitions, skipped, hasUnresolvedNames });
}

async function resolveConfiguredRepositories(config: EnvironmentConfig) {
  const repositoryNames = [
    ...new Set(config.repositories.map((repo) => repo.repository)),
  ];

  const repositoryRows =
    repositoryNames.length > 0
      ? await db.query.repositories.findMany({
          where: and(
            eq(repositories.isActive, true),
            inArray(repositories.fullName, repositoryNames),
          ),
          columns: {
            id: true,
            fullName: true,
            sourceControlProvider: true,
            host: true,
            installationId: true,
          },
        })
      : [];

  const repoMap = new Map(repositoryRows.map((repo) => [repo.fullName, repo]));

  return {
    repositoryRows,
    repositoryIds: repositoryNames
      .map((name) => repoMap.get(name)?.id)
      .filter((id): id is string => Boolean(id)),
  };
}

type ApplyOutcome = 'created' | 'updated' | 'unchanged';

async function createDeclarativeEnvironment(
  definition: DeclarativeEnvironmentDefinition,
  repositoryIds: string[],
): Promise<void> {
  const { config, source } = definition;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(environments)
      .values({
        userId: undefined,
        createdByUserId: null,
        name: config.name,
        description: config.description,
        config,
        declarativeSource: source,
        isVerified: false,
        verificationError: null,
      })
      .returning({ id: environments.id });

    const environment = inserted[0];
    if (!environment) {
      throw new Error('Failed to create environment');
    }

    await createEnvironmentConfigVersionSnapshot(tx, {
      environmentId: environment.id,
      config,
      name: config.name,
      description: config.description ?? null,
      source: 'file',
      createdByUserId: null,
    });

    if (repositoryIds.length > 0) {
      await tx.insert(environmentRepositoryMappings).values(
        repositoryIds.map((repositoryId) => ({
          environmentId: environment.id,
          repositoryId,
        })),
      );
    }
  });
}

async function updateDeclarativeEnvironment(
  environmentId: string,
  currentDeclarativeSource: string | null,
  definition: DeclarativeEnvironmentDefinition,
  repositoryIds: string[],
): Promise<ApplyOutcome> {
  const { config, source } = definition;

  return db.transaction(async (tx) => {
    const { updated } = await updateEnvironmentDefinition(tx, {
      environmentId,
      fields: {
        name: config.name,
        description: config.description ?? null,
        config,
      },
      repositoryIds,
      preserveVerification: true,
      configVersion: {
        config,
        name: config.name,
        description: config.description ?? null,
        source: 'file',
        createdByUserId: null,
      },
    });

    if (currentDeclarativeSource !== source) {
      await tx
        .update(environments)
        .set({ declarativeSource: source })
        .where(eq(environments.id, environmentId));
    }

    return updated ? 'updated' : 'unchanged';
  });
}

async function applyDefinition(
  definition: DeclarativeEnvironmentDefinition,
): Promise<{ outcome: ApplyOutcome } | { skip: DeclarativeEnvironmentSkip }> {
  const { config, source } = definition;

  const { repositoryRows, repositoryIds } =
    await resolveConfiguredRepositories(config);

  const repositoryConfigError =
    getEnvironmentRepositoryConnectionError(repositoryRows);

  if (repositoryConfigError) {
    return { skip: { source, reason: repositoryConfigError } };
  }

  const missingRepositoryError = getMissingEnvironmentRepositoryError(
    config.repositories.map((repository) => repository.repository),
    repositoryRows,
  );

  if (missingRepositoryError) {
    return { skip: { source, reason: missingRepositoryError } };
  }

  const findExisting = () =>
    db.query.environments.findFirst({
      where: eq(environments.name, config.name),
      columns: {
        id: true,
        userId: true,
        isEval: true,
        declarativeSource: true,
      },
    });

  let existing = await findExisting();

  if (!existing) {
    try {
      await createDeclarativeEnvironment(definition, repositoryIds);
      return { outcome: 'created' };
    } catch (error) {
      if (!isEnvironmentNameUniqueViolation(error)) {
        throw error;
      }

      // Another instance created the environment concurrently; fall through
      // to the update path against the now-existing row.
      existing = await findExisting();

      if (!existing) {
        throw error;
      }
    }
  }

  if (existing.isEval || existing.userId !== null) {
    return {
      skip: {
        source,
        reason:
          `Environment name "${config.name}" is already used by a ` +
          `${existing.isEval ? 'reserved internal' : 'user-owned'} ` +
          'environment; declarative definitions can only manage ' +
          'deployment-owned environments.',
      },
    };
  }

  const outcome = await updateDeclarativeEnvironment(
    existing.id,
    existing.declarativeSource,
    definition,
    repositoryIds,
  );

  return { outcome };
}

/**
 * Clear the declarative marker on environments whose definition is no longer
 * part of the declared set. They keep all their data and become normally
 * managed environments again ("orphaning", never pruning).
 */
async function clearOrphanedDeclarativeMarkers(
  declaredNames: string[],
): Promise<string[]> {
  const orphanFilter =
    declaredNames.length > 0
      ? and(
          isNotNull(environments.declarativeSource),
          notInArray(environments.name, declaredNames),
        )
      : isNotNull(environments.declarativeSource);

  const orphaned = await db
    .update(environments)
    .set({ declarativeSource: null })
    .where(orphanFilter)
    .returning({ name: environments.name });

  return orphaned.map((environment) => environment.name);
}

/**
 * Apply the declarative environment set from a mounted directory and/or an
 * inline YAML string. Safe to re-run on every boot: identical definitions are
 * no-ops (no config-version churn, no snapshot invalidation).
 */
export async function applyDeclarativeEnvironments(options: {
  dir?: string;
  inlineYaml?: string;
}): Promise<DeclarativeEnvironmentsSummary> {
  const summary: DeclarativeEnvironmentsSummary = {
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    orphaned: [],
    orphaningDeferred: false,
  };

  const { definitions, skipped, hasUnresolvedNames } =
    await readDeclarativeEnvironmentDefinitions(options);
  summary.skipped.push(...skipped);

  // Names that appear in the declared set (even when their apply is skipped)
  // keep their declarative marker; only names that disappeared entirely are
  // orphaned back to manual management.
  const declaredNames = definitions.map((definition) => definition.config.name);

  for (const definition of definitions) {
    try {
      const result = await applyDefinition(definition);

      if ('skip' in result) {
        summary.skipped.push(result.skip);
        continue;
      }

      summary[result.outcome].push(definition.config.name);
    } catch (error) {
      if (isMissingRelationError(error)) {
        throw error;
      }

      summary.skipped.push({
        source: definition.source,
        reason: `Failed to apply: ${describeParseError(error)}`,
      });
    }
  }

  if (hasUnresolvedNames) {
    // Part of the declared set could not be read or validated, so the names
    // it declares are unknown. Clearing markers now would incorrectly orphan
    // environments whose definition is still present but temporarily broken;
    // defer reconciliation until the whole set parses again.
    summary.orphaningDeferred = true;
  } else {
    summary.orphaned = await clearOrphanedDeclarativeMarkers(declaredNames);
  }

  return summary;
}

function formatSummary(summary: DeclarativeEnvironmentsSummary): string {
  const parts = [
    `created: ${summary.created.length}`,
    `updated: ${summary.updated.length}`,
    `unchanged: ${summary.unchanged.length}`,
    `skipped: ${summary.skipped.length}`,
    `orphaned: ${summary.orphaned.length}`,
  ];

  return parts.join(', ');
}

/**
 * Boot hook for the API process: when `ROOMOTE_ENVIRONMENTS_DIR` and/or
 * `ROOMOTE_ENVIRONMENTS_YAML` are set, apply the declarative environment set.
 *
 * On fresh deployments where the API boots in parallel with the migration
 * step, the `environments` table may not exist yet; that specific failure
 * (Postgres 42P01) is retried with bounded backoff before rethrowing so first
 * boots wait for migrations instead of skipping provisioning. Callers decide
 * whether other errors are fatal; the API boot treats them as non-fatal.
 *
 * Returns the apply summary, or `null` when declarative provisioning is not
 * configured.
 */
export async function bootstrapDeclarativeEnvironments(
  options: {
    processEnv?: NodeJS.ProcessEnv;
    retryDelaysMs?: number[];
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    apply?: typeof applyDeclarativeEnvironments;
  } = {},
): Promise<DeclarativeEnvironmentsSummary | null> {
  const processEnv = options.processEnv ?? process.env;
  const dir =
    processEnv[DECLARATIVE_ENVIRONMENTS_DIR_ENV_VAR]?.trim() || undefined;
  const inlineYaml =
    processEnv[DECLARATIVE_ENVIRONMENTS_YAML_ENV_VAR]?.trim() || undefined;

  if (!dir && !inlineYaml) {
    return null;
  }

  const retryDelaysMs =
    options.retryDelaysMs ?? DEFAULT_MIGRATION_RETRY_DELAYS_MS;
  const log = options.log ?? ((message) => console.info(message));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const apply = options.apply ?? applyDeclarativeEnvironments;

  let summary: DeclarativeEnvironmentsSummary;
  for (let attempt = 0; ; attempt += 1) {
    try {
      summary = await apply({ dir, inlineYaml });
      break;
    } catch (error) {
      if (!isMissingRelationError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }

      const delayMs = retryDelaysMs[attempt]!;
      log(
        '[declarative-environments] environments tables do not exist yet ' +
          '(waiting for migrations); retrying in ' +
          `${delayMs / 1000}s (attempt ${attempt + 1}/${retryDelaysMs.length}).`,
      );
      await sleep(delayMs);
    }
  }

  log(
    `[declarative-environments] Applied declarative environment set (${formatSummary(summary)}).`,
  );

  for (const skip of summary.skipped) {
    log(`[declarative-environments] Skipped ${skip.source}: ${skip.reason}`);
  }

  if (summary.orphaningDeferred) {
    log(
      '[declarative-environments] Deferred orphan reconciliation: part of ' +
        'the declared set could not be read or validated, so existing ' +
        'declarative markers were left untouched.',
    );
  }

  return summary;
}
