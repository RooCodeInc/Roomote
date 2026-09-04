import { describe, expect, it } from 'vitest';

import { CONTROL_PLANE_ENV_VAR_NAMES } from '../control-plane-env-vars';
import { environmentConfigSchema } from '../environment-config';
import {
  NESTED_COMPUTE_ENV_VAR_NAME,
  buildNestedComputeEnv,
  parseNestedComputeEnv,
  serializeNestedComputeEnv,
} from '../nested-compute';

describe('buildNestedComputeEnv', () => {
  it('forwards the default provider and its populated catalog fields', () => {
    expect(
      buildNestedComputeEnv({
        provider: 'modal',
        resolvedEnvValues: {
          MODAL_TOKEN_ID: 'ak-id',
          MODAL_TOKEN_SECRET: 'as-secret',
          MODAL_BASE_IMAGE_REF: 'ghcr.io/roocodeinc/roomote-worker:develop',
          MODAL_REGIONS: '  ',
          UNRELATED: 'ignored',
        },
      }),
    ).toEqual({
      DEFAULT_COMPUTE_PROVIDER: 'modal',
      MODAL_TOKEN_ID: 'ak-id',
      MODAL_TOKEN_SECRET: 'as-secret',
      MODAL_BASE_IMAGE_REF: 'ghcr.io/roocodeinc/roomote-worker:develop',
    });
  });

  it('forwards the managed provider with its broker settings', () => {
    expect(
      buildNestedComputeEnv({
        provider: 'roomote',
        resolvedEnvValues: {
          ROOMOTE_CLOUD_TOKEN_ID: 'tenant',
          ROOMOTE_CLOUD_TOKEN_SECRET: 'rbk_key',
          ROOMOTE_CLOUD_BACKEND: 'broker',
          ROOMOTE_CLOUD_BROKER_URL: 'https://broker.example',
          MODAL_BASE_IMAGE_REF: 'ghcr.io/roocodeinc/roomote-worker@sha256:abc',
        },
      }),
    ).toEqual({
      DEFAULT_COMPUTE_PROVIDER: 'roomote',
      ROOMOTE_CLOUD_TOKEN_ID: 'tenant',
      ROOMOTE_CLOUD_TOKEN_SECRET: 'rbk_key',
      ROOMOTE_CLOUD_BACKEND: 'broker',
      ROOMOTE_CLOUD_BROKER_URL: 'https://broker.example',
      MODAL_BASE_IMAGE_REF: 'ghcr.io/roocodeinc/roomote-worker@sha256:abc',
    });
  });

  it('returns null when a required field is missing', () => {
    expect(
      buildNestedComputeEnv({
        provider: 'modal',
        resolvedEnvValues: { MODAL_TOKEN_ID: 'ak-id' },
      }),
    ).toBeNull();
  });

  it('never nests Local Docker', () => {
    expect(
      buildNestedComputeEnv({ provider: 'docker', resolvedEnvValues: {} }),
    ).toBeNull();
  });
});

describe('parseNestedComputeEnv', () => {
  it('round-trips a serialized env map', () => {
    const env = {
      DEFAULT_COMPUTE_PROVIDER: 'modal',
      MODAL_TOKEN_ID: 'ak-id',
      MODAL_TOKEN_SECRET: 'as-secret',
    };

    expect(parseNestedComputeEnv(serializeNestedComputeEnv(env))).toEqual(env);
  });

  it('rejects blank, malformed, and non-object input', () => {
    expect(parseNestedComputeEnv(undefined)).toBeNull();
    expect(parseNestedComputeEnv('   ')).toBeNull();
    expect(parseNestedComputeEnv('{not json')).toBeNull();
    expect(parseNestedComputeEnv('["MODAL_TOKEN_ID"]')).toBeNull();
    expect(parseNestedComputeEnv('null')).toBeNull();
  });

  it('rejects non-string values and invalid env var names', () => {
    expect(
      parseNestedComputeEnv(
        JSON.stringify({
          DEFAULT_COMPUTE_PROVIDER: 'modal',
          MODAL_TOKEN_ID: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseNestedComputeEnv(
        JSON.stringify({
          DEFAULT_COMPUTE_PROVIDER: 'modal',
          'BAD NAME; rm -rf': 'x',
        }),
      ),
    ).toBeNull();
  });

  it('rejects an unknown or missing provider', () => {
    expect(
      parseNestedComputeEnv(JSON.stringify({ MODAL_TOKEN_ID: 'ak-id' })),
    ).toBeNull();
    expect(
      parseNestedComputeEnv(
        JSON.stringify({ DEFAULT_COMPUTE_PROVIDER: 'mainframe' }),
      ),
    ).toBeNull();
  });
});

describe('nested compute wiring', () => {
  it('reserves the forwarding name from the generic environment editor', () => {
    expect(CONTROL_PLANE_ENV_VAR_NAMES.has(NESTED_COMPUTE_ENV_VAR_NAME)).toBe(
      true,
    );
  });

  it('accepts inherit_compute on an environment definition', () => {
    const result = environmentConfigSchema.safeParse({
      name: 'Nested Roomote',
      repositories: [{ repository: 'acme/app' }],
      inherit_compute: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.inherit_compute).toBe(true);
  });

  it('rejects a non-boolean inherit_compute', () => {
    expect(
      environmentConfigSchema.safeParse({
        name: 'Nested Roomote',
        repositories: [{ repository: 'acme/app' }],
        inherit_compute: 'yes',
      }).success,
    ).toBe(false);
  });
});
