import { describe, expect, it } from 'vitest';

import { CONTROL_PLANE_ENV_VAR_NAMES } from '../control-plane-env-vars';
import { environmentConfigSchema } from '../environment-config';
import {
  NESTED_DEPLOYMENT_ENV_VAR_NAME,
  NESTED_SOURCE_CONTROL_ENV_VAR_NAMES,
  buildNestedComputeEnv,
  buildNestedSourceControlEnv,
  mergeNestedDeploymentEnv,
  parseNestedDeploymentEnv,
  serializeNestedDeploymentEnv,
} from '../nested-deployment-env';

const GITHUB_APP_ENV = {
  R_GITHUB_APP_SLUG: 'roomote-test',
  R_GITHUB_APP_ID: '12345',
  R_GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END',
  R_GITHUB_CLIENT_ID: 'Iv1.abc',
  R_GITHUB_CLIENT_SECRET: 'client-secret',
  R_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
};

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

describe('buildNestedSourceControlEnv', () => {
  it('forwards every fully configured provider', () => {
    expect(
      buildNestedSourceControlEnv({
        resolvedEnvValues: {
          ...GITHUB_APP_ENV,
          GITEA_BASE_URL: 'https://gitea.example',
          GITEA_CLIENT_ID: 'gitea-client',
          GITEA_CLIENT_SECRET: 'gitea-secret',
          UNRELATED: 'ignored',
        },
      }),
    ).toEqual({
      ...GITHUB_APP_ENV,
      GITEA_BASE_URL: 'https://gitea.example',
      GITEA_CLIENT_ID: 'gitea-client',
      GITEA_CLIENT_SECRET: 'gitea-secret',
    });
  });

  it('skips a provider that is only partially configured', () => {
    expect(
      buildNestedSourceControlEnv({
        resolvedEnvValues: {
          ...GITHUB_APP_ENV,
          GITEA_BASE_URL: 'https://gitea.example',
        },
      }),
    ).toEqual(GITHUB_APP_ENV);
  });

  it('returns null when no provider is configured', () => {
    expect(
      buildNestedSourceControlEnv({
        resolvedEnvValues: { R_GITHUB_APP_ID: '12345' },
      }),
    ).toBeNull();
  });

  it('covers the GitHub App fields in the resolved name list', () => {
    for (const name of Object.keys(GITHUB_APP_ENV)) {
      expect(NESTED_SOURCE_CONTROL_ENV_VAR_NAMES).toContain(name);
    }
  });
});

describe('mergeNestedDeploymentEnv', () => {
  it('merges populated parts and drops empty ones', () => {
    expect(
      mergeNestedDeploymentEnv({ DEFAULT_COMPUTE_PROVIDER: 'modal' }, null, {
        R_GITHUB_APP_ID: '12345',
      }),
    ).toEqual({ DEFAULT_COMPUTE_PROVIDER: 'modal', R_GITHUB_APP_ID: '12345' });
    expect(mergeNestedDeploymentEnv(null, undefined)).toBeNull();
  });
});

describe('parseNestedDeploymentEnv', () => {
  it('round-trips a serialized env map', () => {
    const env = {
      DEFAULT_COMPUTE_PROVIDER: 'modal',
      MODAL_TOKEN_ID: 'ak-id',
      MODAL_TOKEN_SECRET: 'as-secret',
      R_GITHUB_APP_ID: '12345',
    };

    expect(parseNestedDeploymentEnv(serializeNestedDeploymentEnv(env))).toEqual(
      env,
    );
  });

  it('accepts a source-control-only map', () => {
    expect(parseNestedDeploymentEnv(JSON.stringify(GITHUB_APP_ENV))).toEqual(
      GITHUB_APP_ENV,
    );
  });

  it('rejects blank, malformed, empty, and non-object input', () => {
    expect(parseNestedDeploymentEnv(undefined)).toBeNull();
    expect(parseNestedDeploymentEnv('   ')).toBeNull();
    expect(parseNestedDeploymentEnv('{not json')).toBeNull();
    expect(parseNestedDeploymentEnv('["MODAL_TOKEN_ID"]')).toBeNull();
    expect(parseNestedDeploymentEnv('null')).toBeNull();
    expect(parseNestedDeploymentEnv('{}')).toBeNull();
  });

  it('rejects non-string values and invalid env var names', () => {
    expect(
      parseNestedDeploymentEnv(
        JSON.stringify({
          DEFAULT_COMPUTE_PROVIDER: 'modal',
          MODAL_TOKEN_ID: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseNestedDeploymentEnv(
        JSON.stringify({
          DEFAULT_COMPUTE_PROVIDER: 'modal',
          'BAD NAME; rm -rf': 'x',
        }),
      ),
    ).toBeNull();
  });

  it('rejects an unknown compute provider', () => {
    expect(
      parseNestedDeploymentEnv(
        JSON.stringify({ DEFAULT_COMPUTE_PROVIDER: 'mainframe' }),
      ),
    ).toBeNull();
  });
});

describe('nested deployment wiring', () => {
  it('reserves the forwarding name from the generic environment editor', () => {
    expect(
      CONTROL_PLANE_ENV_VAR_NAMES.has(NESTED_DEPLOYMENT_ENV_VAR_NAME),
    ).toBe(true);
  });

  it('accepts the inherit flags on an environment definition', () => {
    const result = environmentConfigSchema.safeParse({
      name: 'Nested Roomote',
      repositories: [{ repository: 'acme/app' }],
      inherit_compute: true,
      inherit_source_control: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.inherit_compute).toBe(true);
    expect(result.success && result.data.inherit_source_control).toBe(true);
  });

  it('rejects non-boolean inherit flags', () => {
    const base = {
      name: 'Nested Roomote',
      repositories: [{ repository: 'acme/app' }],
    };

    expect(
      environmentConfigSchema.safeParse({ ...base, inherit_compute: 'yes' })
        .success,
    ).toBe(false);
    expect(
      environmentConfigSchema.safeParse({
        ...base,
        inherit_source_control: 'yes',
      }).success,
    ).toBe(false);
  });
});
