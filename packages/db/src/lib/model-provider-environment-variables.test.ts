import { db } from '../db';
import {
  environmentVariables,
  modelProviderEnvironmentVariables,
} from '../schema';

import {
  getPersistedModelProviderEnvironmentVariableNames,
  getPersistedModelProviderEnvironmentVariableValues,
} from './model-provider-environment-variables';

describe('model provider environment variables', () => {
  beforeEach(async () => {
    await db.delete(modelProviderEnvironmentVariables);
    await db.delete(environmentVariables);
  });

  it('falls back to legacy model-provider rows during the N-1 rollout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await db.insert(environmentVariables).values({
      userId: null,
      name: 'TOGETHER_API_KEY',
      value: 'legacy-key',
      createdByUserId: null,
      lastUpdatedByUserId: null,
    });

    await expect(
      getPersistedModelProviderEnvironmentVariableValues(['TOGETHER_API_KEY']),
    ).resolves.toEqual({ TOGETHER_API_KEY: 'legacy-key' });
    await expect(
      getPersistedModelProviderEnvironmentVariableNames(),
    ).resolves.toContain('TOGETHER_API_KEY');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Using legacy persisted model-provider value name=TOGETHER_API_KEY',
      ),
    );
    warn.mockRestore();
  });

  it('prefers the dedicated model-provider value over its legacy copy', async () => {
    await Promise.all([
      db.insert(environmentVariables).values({
        userId: null,
        name: 'TOGETHER_API_KEY',
        value: 'legacy-key',
        createdByUserId: null,
        lastUpdatedByUserId: null,
      }),
      db.insert(modelProviderEnvironmentVariables).values({
        name: 'TOGETHER_API_KEY',
        value: 'dedicated-key',
        createdByUserId: null,
        lastUpdatedByUserId: null,
      }),
    ]);

    await expect(
      getPersistedModelProviderEnvironmentVariableValues(['TOGETHER_API_KEY']),
    ).resolves.toEqual({ TOGETHER_API_KEY: 'dedicated-key' });
  });

  it('ignores unrelated legacy task variables but keeps declared custom model keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db.insert(environmentVariables).values([
      {
        userId: null,
        name: 'R_MODEL_ENV_KEYS',
        value: 'CUSTOM_LLM_TOKEN',
        createdByUserId: null,
        lastUpdatedByUserId: null,
      },
      {
        userId: null,
        name: 'CUSTOM_LLM_TOKEN',
        value: 'model-token',
        createdByUserId: null,
        lastUpdatedByUserId: null,
      },
      {
        userId: null,
        name: 'STRIPE_API_KEY',
        value: 'task-token',
        createdByUserId: null,
        lastUpdatedByUserId: null,
      },
    ]);

    await expect(
      getPersistedModelProviderEnvironmentVariableValues([
        'CUSTOM_LLM_TOKEN',
        'STRIPE_API_KEY',
      ]),
    ).resolves.toEqual({ CUSTOM_LLM_TOKEN: 'model-token' });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('STRIPE_API_KEY'),
    );
    warn.mockRestore();
  });

  it('backfills built-in and named OpenAI-compatible rows without deleting legacy data', async () => {
    const migration = await readFile(
      new URL('../../drizzle/0028_odd_wolfsbane.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain(
      'INSERT INTO "model_provider_environment_variables"',
    );
    expect(migration).toContain("'TOGETHER_API_KEY'");
    expect(migration).toContain('"name" LIKE \'OPENAI_COMPATIBLE_%_API_KEY\'');
    expect(migration).not.toContain('DELETE FROM "environment_variables"');
  });
});
import { readFile } from 'node:fs/promises';
