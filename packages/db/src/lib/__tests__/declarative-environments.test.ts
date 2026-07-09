import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { environmentConfigSchema } from '@roomote/types';
import YAML from 'yaml';

import {
  db,
  environmentConfigVersions,
  environmentRepositoryMappings,
  environments,
  eq,
  githubInstallationFactory,
  githubInstallations,
  inArray,
  repositoryFactory,
  repositories,
  userFactory,
  users,
} from '../../server';

import {
  applyDeclarativeEnvironments,
  bootstrapDeclarativeEnvironments,
} from '../declarative-environments';
import { updateEnvironmentDefinition } from '../environment-definitions';

const namePrefix = `Declarative Test ${randomUUID().slice(0, 8)}`;

let definitionsDir: string;
let testUserId: string;
let testInstallationId: string | null = null;

function environmentName(suffix: string): string {
  return `${namePrefix} ${suffix}`;
}

async function createLinkedRepository() {
  if (!testUserId) {
    testUserId = randomUUID();
    await userFactory.create({ id: testUserId });
  }

  const installation = await githubInstallationFactory.create({
    installedByUserId: testUserId,
  });
  testInstallationId = installation.id;

  return repositoryFactory.create({
    fullName: 'declarative-test/example',
    installationId: installation.id,
    linkedByUserId: testUserId,
  });
}

function definitionYaml(
  name: string,
  overrides: Record<string, unknown> = {},
): string {
  return YAML.stringify({
    name,
    repositories: [{ repository: 'declarative-test/example' }],
    ...overrides,
  });
}

async function cleanup() {
  const testEnvironments = await db.query.environments.findMany({
    columns: { id: true, name: true },
  });
  const testIds = testEnvironments
    .filter((environment) => environment.name.startsWith(namePrefix))
    .map((environment) => environment.id);

  if (testIds.length > 0) {
    await db
      .delete(environmentConfigVersions)
      .where(inArray(environmentConfigVersions.environmentId, testIds));
    await db
      .delete(environmentRepositoryMappings)
      .where(inArray(environmentRepositoryMappings.environmentId, testIds));
    await db.delete(environments).where(inArray(environments.id, testIds));
  }

  await db
    .delete(repositories)
    .where(eq(repositories.fullName, 'declarative-test/example'));

  if (testInstallationId) {
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, testInstallationId));
    testInstallationId = null;
  }

  if (testUserId) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
}

describe('declarative environments', () => {
  beforeEach(async () => {
    testUserId = '';
    await cleanup();
    definitionsDir = await mkdtemp(
      path.join(tmpdir(), 'roomote-declarative-envs-'),
    );
  });

  afterEach(async () => {
    await cleanup();
    await rm(definitionsDir, { recursive: true, force: true });
  });

  it('creates an environment from a directory file', async () => {
    const name = environmentName('create');
    const repository = await createLinkedRepository();

    await writeFile(
      path.join(definitionsDir, 'create.yaml'),
      definitionYaml(name, { description: 'From file' }),
    );

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });

    expect(summary.created).toEqual([name]);
    expect(summary.skipped).toEqual([]);
    expect(summary.missingRepositories).toEqual([]);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });

    expect(environment).toBeDefined();
    expect(environment?.declarativeSource).toBe('create.yaml');
    expect(environment?.createdByUserId).toBeNull();
    expect(environment?.userId).toBeNull();
    expect(environment?.description).toBe('From file');

    const versions = await db.query.environmentConfigVersions.findMany({
      where: eq(environmentConfigVersions.environmentId, environment!.id),
    });

    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('file');
    expect(versions[0]?.createdByUserId).toBeNull();

    const mappings = await db.query.environmentRepositoryMappings.findMany({
      where: eq(environmentRepositoryMappings.environmentId, environment!.id),
    });

    expect(mappings.map((mapping) => mapping.repositoryId)).toEqual([
      repository.id,
    ]);
  });

  it('applies inline multi-document YAML and dedupes by name against directory files', async () => {
    const dirName = environmentName('dir-wins');
    const inlineOnlyName = environmentName('inline-only');

    await writeFile(
      path.join(definitionsDir, 'dir.yaml'),
      definitionYaml(dirName, { description: 'from dir' }),
    );

    const inlineYaml = [
      definitionYaml(dirName, { description: 'from inline (loses)' }),
      definitionYaml(inlineOnlyName),
    ].join('\n---\n');

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
      inlineYaml,
    });

    expect(summary.created.sort()).toEqual([dirName, inlineOnlyName].sort());
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.source).toBe('env:1');
    expect(summary.skipped[0]?.reason).toContain('Duplicate environment name');

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, dirName),
    });
    expect(environment?.description).toBe('from dir');

    const inlineEnvironment = await db.query.environments.findFirst({
      where: eq(environments.name, inlineOnlyName),
    });
    expect(inlineEnvironment?.declarativeSource).toBe('env:2');
  });

  it('is idempotent: identical re-apply is unchanged and creates no version churn', async () => {
    const name = environmentName('idempotent');
    await writeFile(
      path.join(definitionsDir, 'idempotent.yaml'),
      definitionYaml(name),
    );

    const first = await applyDeclarativeEnvironments({ dir: definitionsDir });
    expect(first.created).toEqual([name]);

    const second = await applyDeclarativeEnvironments({ dir: definitionsDir });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual([name]);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });
    const versions = await db.query.environmentConfigVersions.findMany({
      where: eq(environmentConfigVersions.environmentId, environment!.id),
    });

    expect(versions).toHaveLength(1);
  });

  it('re-applies the declarative definition over later manual edits', async () => {
    const name = environmentName('file-wins');
    await writeFile(
      path.join(definitionsDir, 'file-wins.yaml'),
      definitionYaml(name, { description: 'declared' }),
    );

    await applyDeclarativeEnvironments({ dir: definitionsDir });

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });

    testUserId = randomUUID();
    await userFactory.create({ id: testUserId });

    const editedConfig = environmentConfigSchema.parse({
      name,
      description: 'manually edited',
      repositories: [{ repository: 'declarative-test/example' }],
    });

    await updateEnvironmentDefinition(db, {
      environmentId: environment!.id,
      fields: {
        name,
        description: 'manually edited',
        config: editedConfig,
      },
      configVersion: {
        config: editedConfig,
        name,
        description: 'manually edited',
        source: 'user',
        createdByUserId: testUserId,
      },
    });

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });
    expect(summary.updated).toEqual([name]);

    const reverted = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });
    expect(reverted?.description).toBe('declared');
    expect(reverted?.config.description).toBe('declared');

    const versions = await db.query.environmentConfigVersions.findMany({
      where: eq(environmentConfigVersions.environmentId, environment!.id),
    });

    expect(versions.map((version) => version.source).sort()).toEqual(
      ['file', 'file', 'user'].sort(),
    );
  });

  it('orphans environments whose definition disappears instead of deleting them', async () => {
    const name = environmentName('orphan');
    const filePath = path.join(definitionsDir, 'orphan.yaml');
    await writeFile(filePath, definitionYaml(name));

    await applyDeclarativeEnvironments({ dir: definitionsDir });
    await rm(filePath);

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });

    expect(summary.orphaned).toContain(name);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });

    expect(environment).toBeDefined();
    expect(environment?.declarativeSource).toBeNull();
  });

  it('skips invalid definitions while applying the rest', async () => {
    const validName = environmentName('valid');

    await writeFile(
      path.join(definitionsDir, 'a-invalid.yaml'),
      YAML.stringify({ name: 'missing repositories' }),
    );
    await writeFile(
      path.join(definitionsDir, 'b-broken.yaml'),
      'name: [unclosed',
    );
    await writeFile(
      path.join(definitionsDir, 'c-valid.yaml'),
      definitionYaml(validName),
    );

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });

    expect(summary.created).toEqual([validName]);
    expect(summary.skipped.map((skip) => skip.source).sort()).toEqual([
      'a-invalid.yaml',
      'b-broken.yaml',
    ]);
  });

  it('applies inline YAML even when the definitions directory is unreadable', async () => {
    const inlineName = environmentName('inline-survives');

    const summary = await applyDeclarativeEnvironments({
      dir: path.join(definitionsDir, 'does-not-exist'),
      inlineYaml: definitionYaml(inlineName),
    });

    expect(summary.created).toEqual([inlineName]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.source).toBe('ROOMOTE_ENVIRONMENTS_DIR');
    expect(summary.skipped[0]?.reason).toContain('Failed to read directory');
    expect(summary.orphaningDeferred).toBe(true);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, inlineName),
    });
    expect(environment?.declarativeSource).toBe('env:1');
  });

  it('keeps declarative markers when a still-present definition fails to parse', async () => {
    const name = environmentName('broken-but-present');
    const filePath = path.join(definitionsDir, 'broken-later.yaml');
    await writeFile(filePath, definitionYaml(name));

    await applyDeclarativeEnvironments({ dir: definitionsDir });

    // The file is still present but temporarily invalid; its environment must
    // keep its declarative marker instead of being orphaned.
    await writeFile(filePath, 'name: [unclosed');

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });

    expect(summary.orphaned).toEqual([]);
    expect(summary.orphaningDeferred).toBe(true);
    expect(summary.skipped.map((skip) => skip.source)).toEqual([
      'broken-later.yaml',
    ]);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });
    expect(environment?.declarativeSource).toBe('broken-later.yaml');
  });

  it('never touches user-owned or eval environments with the same name', async () => {
    testUserId = randomUUID();
    await userFactory.create({ id: testUserId });

    const userOwnedName = environmentName('user-owned');
    const evalName = environmentName('eval');

    const userOwnedConfig = environmentConfigSchema.parse({
      name: userOwnedName,
      repositories: [{ repository: 'declarative-test/example' }],
    });
    const evalConfig = environmentConfigSchema.parse({
      name: evalName,
      repositories: [{ repository: 'declarative-test/example' }],
    });

    await db.insert(environments).values([
      {
        userId: testUserId,
        createdByUserId: testUserId,
        name: userOwnedName,
        config: userOwnedConfig,
      },
      {
        createdByUserId: testUserId,
        name: evalName,
        config: evalConfig,
        isEval: true,
      },
    ]);

    await writeFile(
      path.join(definitionsDir, 'user-owned.yaml'),
      definitionYaml(userOwnedName, { description: 'declarative override' }),
    );
    await writeFile(
      path.join(definitionsDir, 'eval.yaml'),
      definitionYaml(evalName, { description: 'declarative override' }),
    );

    const summary = await applyDeclarativeEnvironments({
      dir: definitionsDir,
    });

    expect(summary.created).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(summary.skipped).toHaveLength(2);

    const userOwned = await db.query.environments.findFirst({
      where: eq(environments.name, userOwnedName),
    });
    expect(userOwned?.description).toBeNull();
    expect(userOwned?.declarativeSource).toBeNull();
  });

  it('backfills repository mappings once a configured repository is linked', async () => {
    const name = environmentName('backfill');
    await writeFile(
      path.join(definitionsDir, 'backfill.yaml'),
      definitionYaml(name),
    );

    const first = await applyDeclarativeEnvironments({ dir: definitionsDir });
    expect(first.missingRepositories).toEqual(['declarative-test/example']);

    const environment = await db.query.environments.findFirst({
      where: eq(environments.name, name),
    });

    let mappings = await db.query.environmentRepositoryMappings.findMany({
      where: eq(environmentRepositoryMappings.environmentId, environment!.id),
    });
    expect(mappings).toHaveLength(0);

    const repository = await createLinkedRepository();

    const second = await applyDeclarativeEnvironments({ dir: definitionsDir });
    expect(second.updated).toEqual([name]);
    expect(second.missingRepositories).toEqual([]);

    mappings = await db.query.environmentRepositoryMappings.findMany({
      where: eq(environmentRepositoryMappings.environmentId, environment!.id),
    });
    expect(mappings.map((mapping) => mapping.repositoryId)).toEqual([
      repository.id,
    ]);
  });

  describe('bootstrapDeclarativeEnvironments', () => {
    it('returns null when declarative provisioning is not configured', async () => {
      const result = await bootstrapDeclarativeEnvironments({
        processEnv: {} as NodeJS.ProcessEnv,
      });

      expect(result).toBeNull();
    });

    it('retries when environment tables have not been migrated yet', async () => {
      const emptySummary = {
        created: [],
        updated: [],
        unchanged: [],
        skipped: [],
        orphaned: [],
        orphaningDeferred: false,
        missingRepositories: [],
      };

      const apply = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('relation "environments" does not exist'), {
            code: '42P01',
          }),
        )
        .mockResolvedValueOnce(emptySummary);

      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await bootstrapDeclarativeEnvironments({
        processEnv: {
          ROOMOTE_ENVIRONMENTS_DIR: definitionsDir,
        } as unknown as NodeJS.ProcessEnv,
        apply,
        sleep,
        log: () => {},
      });

      expect(result).toEqual(emptySummary);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-migration errors', async () => {
      const apply = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(
        bootstrapDeclarativeEnvironments({
          processEnv: {
            ROOMOTE_ENVIRONMENTS_YAML: definitionYaml(
              environmentName('unused'),
            ),
          } as unknown as NodeJS.ProcessEnv,
          apply,
          sleep: vi.fn().mockResolvedValue(undefined),
          log: () => {},
        }),
      ).rejects.toThrow('boom');

      expect(apply).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the checked-in Roomote definition valid against the schema', () => {
    const dogfoodPath = path.resolve(
      __dirname,
      '../../../../../.roomote/environments/roomote.yaml',
    );

    const parsed = YAML.parse(readFileSync(dogfoodPath, 'utf8'));
    const result = environmentConfigSchema.safeParse(parsed);

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.name).toBe('Roomote');
  });
});
