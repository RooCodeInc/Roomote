import { randomUUID } from 'node:crypto';

import {
  db,
  environmentFactory,
  environments,
  eq,
  environmentConfigVersions,
  userFactory,
} from '../../server';
import {
  ensureEnvironmentRecipeCandidate,
  finalizeEnvironmentRecipeResolution,
  markEnvironmentVerificationFailedIfCurrent,
} from '../environment-recipes';

import type { EnvironmentRecipe } from '@roomote/types';

function unresolvedRecipe(packages: string[], fingerprintChar: string) {
  return {
    type: 'r-bioconductor',
    schema_version: 1,
    request: { packages },
    request_fingerprint: fingerprintChar.repeat(64),
  } satisfies EnvironmentRecipe;
}

const resolvedRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2', 'airway'] },
  request_fingerprint: 'a'.repeat(64),
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
} satisfies EnvironmentRecipe;

describe('environment recipe provisioning and finalization', () => {
  it('creates a single candidate for a fingerprint and reuses it idempotently', async () => {
    const user = await userFactory.create();
    const recipe = unresolvedRecipe(['DESeq2'], 'c');
    const name = `Ensure recipe test ${randomUUID().slice(0, 8)}-recipe`;
    const config = {
      name,
      description: 'Differential expression work',
      environment_recipe: recipe,
      repositories: [] as never[],
    };

    const first = await ensureEnvironmentRecipeCandidate({
      config,
      createdByUserId: user.id,
    });
    const second = await ensureEnvironmentRecipeCandidate({
      config,
      createdByUserId: user.id,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.environmentId).toBe(second.environmentId);
  });

  it('finalization preserves the current verification binding and records version 1', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: {
        name: `Recipe finalize ${randomUUID().slice(0, 8)}`,
        repositories: [],
        environment_recipe: unresolvedRecipe(['DESeq2', 'airway'], 'd'),
      },
      description: null,
      verificationTaskId: 'task-bound',
      isVerified: false,
      verificationError: null,
    });

    const recipe = {
      ...(resolvedRecipe as EnvironmentRecipe),
      request_fingerprint:
        environment.config.environment_recipe!.request_fingerprint,
    } as EnvironmentRecipe;

    const result = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-bound',
      recipe,
      acceptRecipeResolution: () => null,
    });

    expect(result.status).toBe('applied');

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.verificationTaskId).toBe('task-bound');
    expect(updated?.config.environment_recipe?.resolution).toBeTruthy();

    const versions = await db
      .select({ version: environmentConfigVersions.version })
      .from(environmentConfigVersions)
      .where(eq(environmentConfigVersions.environmentId, environment.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });

  it('finalization is idempotent for an identical resolution and rejects differing ones', async () => {
    const recipe = resolvedRecipe;
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: {
        name: `Recipe idempotent ${randomUUID().slice(0, 8)}`,
        repositories: [],
        environment_recipe: recipe,
      },
      description: null,
      verificationTaskId: 'task-bound',
      isVerified: false,
      verificationError: null,
    });

    const first = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-bound',
      recipe,
      acceptRecipeResolution: () => null,
    });

    expect(first.status).toBe('applied');

    const second = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-bound',
      recipe,
      acceptRecipeResolution: () => null,
    });

    expect(second.status).toBe('applied');

    const differing = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-bound',
      recipe: {
        ...recipe,
        resolution: {
          ...recipe.resolution!,
          packages: [
            ...recipe.resolution!.packages,
            { name: 'edgeR', version: '1.0.0', repository: 'bioconductor' },
          ],
        },
      },
      acceptRecipeResolution: () => null,
    });

    expect(differing.status).toBe('rejected');
  });

  it('rejects finalization from a stale verification run', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: {
        name: `Recipe stale ${randomUUID().slice(0, 8)}`,
        repositories: [],
        environment_recipe: unresolvedRecipe(['DESeq2'], 'e'),
      },
      description: null,
      verificationTaskId: 'task-current',
      isVerified: false,
      verificationError: null,
    });

    const result = await finalizeEnvironmentRecipeResolution(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-old',
      recipe: resolvedRecipe,
      acceptRecipeResolution: () => null,
    });

    expect(result.status).toBe('stale');
  });

  it('marks a failed bootstrap/canceled attempt only when it is still current and unverified', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      isVerified: false,
      verificationTaskId: 'task-current',
      verificationError: null,
    });

    const stale = await markEnvironmentVerificationFailedIfCurrent(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-older',
      error: 'bootstrap failed',
    });
    expect(stale.marked).toBe(false);

    const current = await markEnvironmentVerificationFailedIfCurrent(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-current',
      error: 'bootstrap failed',
    });
    expect(current.marked).toBe(true);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });
    expect(updated?.verificationError).toBe('bootstrap failed');
  });
});
