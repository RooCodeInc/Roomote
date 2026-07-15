import { randomUUID } from 'node:crypto';

import { environmentConfigSchema } from '@roomote/types';

import {
  db,
  environmentFactory,
  environments,
  eq,
  recordEnvironmentVerification,
  beginEnvironmentVerification,
  updateEnvironmentDefinition,
} from '../../server';

function buildConfig(overrides?: {
  name?: string;
  description?: string;
  install?: string;
}) {
  const name = overrides?.name ?? `Verify Test ${randomUUID().slice(0, 8)}`;
  return environmentConfigSchema.parse({
    name,
    description: overrides?.description,
    repositories: [
      {
        repository: 'verify-test/example',
        commands: overrides?.install
          ? [{ name: 'Install', run: overrides.install }]
          : undefined,
      },
    ],
  });
}

async function createUnverifiedEnvironment(configOverrides?: {
  description?: string;
  install?: string;
}) {
  const config = buildConfig(configOverrides);
  return environmentFactory.create({
    name: config.name,
    description: config.description ?? null,
    config,
    createdByUserId: null,
    isVerified: false,
    verificationError: null,
  });
}

describe('environment verification state', () => {
  it('records a successful verification when the task id matches', async () => {
    const environment = await createUnverifiedEnvironment();
    await beginEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-1',
    });

    const result = await recordEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-1',
      success: true,
    });

    expect(result.recorded).toBe(true);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(true);
    expect(updated?.verifiedAt).toBeInstanceOf(Date);
    expect(updated?.verificationError).toBeNull();
  });

  it('records a failed verification with a sanitized error and keeps the environment usable', async () => {
    const environment = await createUnverifiedEnvironment();
    await beginEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-2',
    });

    const result = await recordEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-2',
      success: false,
      error: 'Server failed to start on port 3000',
    });

    expect(result.recorded).toBe(true);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(false);
    expect(updated?.verifiedAt).toBeNull();
    expect(updated?.verificationError).toBe(
      'Server failed to start on port 3000',
    );
  });

  it('rejects a stale verification task id so a newer attempt cannot be overwritten', async () => {
    const environment = await createUnverifiedEnvironment();
    // A newer attempt is registered.
    await beginEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-new',
    });

    const result = await recordEnvironmentVerification(db, {
      environmentId: environment.id,
      verificationTaskId: 'task-stale',
      success: true,
    });

    expect(result.recorded).toBe(false);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(false);
    expect(updated?.verificationTaskId).toBe('task-new');
  });

  it('clears verification on a runtime-affecting (config) edit', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: buildConfig({ install: 'npm install' }),
      isVerified: true,
      verifiedAt: new Date(),
      verificationTaskId: 'task-old',
      verificationError: null,
    });

    const nextConfig = buildConfig({
      name: environment.name,
      install: 'npm ci',
    });

    const { verificationCleared } = await updateEnvironmentDefinition(db, {
      environmentId: environment.id,
      fields: { config: nextConfig },
    });

    expect(verificationCleared).toBe(true);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(false);
    expect(updated?.verifiedAt).toBeNull();
    expect(updated?.verificationTaskId).toBeNull();
  });

  it('preserves verification on a metadata-only (description) edit', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: buildConfig({ description: 'before' }),
      description: 'before',
      isVerified: true,
      verifiedAt: new Date(),
      verificationTaskId: 'task-keep',
      verificationError: null,
    });

    const { verificationCleared } = await updateEnvironmentDefinition(db, {
      environmentId: environment.id,
      fields: { description: 'after (metadata only)' },
    });

    expect(verificationCleared).toBe(false);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(true);
    expect(updated?.verificationTaskId).toBe('task-keep');
  });

  it('does not clear verification for declarative edits (preserveVerification)', async () => {
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: buildConfig({ install: 'npm install' }),
      isVerified: true,
      verifiedAt: new Date(),
      verificationTaskId: 'task-declarative',
      verificationError: null,
    });

    const nextConfig = buildConfig({
      name: environment.name,
      install: 'npm ci',
    });

    const { verificationCleared } = await updateEnvironmentDefinition(db, {
      environmentId: environment.id,
      fields: { config: nextConfig },
      preserveVerification: true,
    });

    expect(verificationCleared).toBe(false);

    const updated = await db.query.environments.findFirst({
      where: eq(environments.id, environment.id),
    });

    expect(updated?.isVerified).toBe(true);
    expect(updated?.verificationTaskId).toBe('task-declarative');
  });
});
