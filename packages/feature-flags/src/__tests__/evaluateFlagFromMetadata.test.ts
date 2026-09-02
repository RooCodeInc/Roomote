import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  coerceToBoolean,
  evaluateFeatureFlagsFromMetadata,
  normalizeMetadataRecord,
} from '../index';
import type { FeatureFlag } from '../types';

describe('generic feature flag evaluation', () => {
  it('keeps generic boolean coercion behavior', () => {
    expect(coerceToBoolean(true)).toBe(true);
    expect(coerceToBoolean('TRUE')).toBe(true);
    expect(coerceToBoolean('false')).toBe(false);
    expect(coerceToBoolean(1)).toBe(true);
    expect(coerceToBoolean(0)).toBe(false);
  });

  it('normalizes invalid public metadata to an empty object', () => {
    expect(normalizeMetadataRecord(null)).toEqual({});
    expect(normalizeMetadataRecord([])).toEqual({});
    expect(normalizeMetadataRecord({ stale_flag: true })).toEqual({
      stale_flag: true,
    });
  });

  it('evaluates configured flags and ignores stale metadata keys', () => {
    expect(evaluateFeatureFlagsFromMetadata({})).toEqual({
      composerSuggestions: false,
    });
    expect(
      evaluateFeatureFlagsFromMetadata({
        stale_flag: true,
        sessions_data: true,
        sessions_ui: 'true',
      }),
    ).toEqual({ composerSuggestions: false });
    expect(
      evaluateFeatureFlagsFromMetadata({ composerSuggestions: true }),
    ).toEqual({ composerSuggestions: true });
  });
});

describe('flag machinery with a synthetic config', () => {
  const SYNTHETIC_FLAG = 'synthetic_flag' as unknown as FeatureFlag;
  const OVERRIDDEN_FLAG = 'overridden_flag' as unknown as FeatureFlag;

  async function importWithSyntheticConfig() {
    vi.resetModules();
    vi.doMock('../types', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../types')>()),
      FeatureFlag: {
        SyntheticFlag: 'synthetic_flag',
        OverriddenFlag: 'overridden_flag',
      },
    }));
    vi.doMock('../config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../config')>()),
      FEATURE_FLAG_CONFIG: {
        synthetic_flag: {
          defaultValue: false,
          metadataKey: 'synthetic_flag',
          legacyMetadataKeys: ['synthetic_flag_legacy'],
          description: 'Synthetic flag for machinery tests',
          group: 'testing',
        },
        overridden_flag: {
          defaultValue: false,
          override: () => true,
        },
      },
    }));
    return import('../index');
  }

  afterEach(() => {
    vi.doUnmock('../types');
    vi.doUnmock('../config');
    vi.resetModules();
  });

  it('falls back to the default value when metadata has no key', async () => {
    const { evaluateFeatureFlagFromMetadata } =
      await importWithSyntheticConfig();

    expect(evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, {})).toBe(false);
    expect(evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, null)).toBe(false);
  });

  it('reads and coerces the primary metadata key', async () => {
    const { evaluateFeatureFlagFromMetadata } =
      await importWithSyntheticConfig();

    expect(
      evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, { synthetic_flag: true }),
    ).toBe(true);
    expect(
      evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, {
        synthetic_flag: 'true',
      }),
    ).toBe(true);
    expect(
      evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, {
        synthetic_flag: false,
      }),
    ).toBe(false);
  });

  it('honors legacy metadata keys with the primary key winning', async () => {
    const { evaluateFeatureFlagFromMetadata } =
      await importWithSyntheticConfig();

    expect(
      evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, {
        synthetic_flag_legacy: true,
      }),
    ).toBe(true);
    expect(
      evaluateFeatureFlagFromMetadata(SYNTHETIC_FLAG, {
        synthetic_flag: false,
        synthetic_flag_legacy: true,
      }),
    ).toBe(false);
  });

  it('lets earlier metadata sources shadow later ones', async () => {
    const { evaluateFeatureFlagFromMetadataSources } =
      await importWithSyntheticConfig();

    expect(
      evaluateFeatureFlagFromMetadataSources(SYNTHETIC_FLAG, [
        { synthetic_flag: true },
        { synthetic_flag: false },
      ]),
    ).toBe(true);
    expect(
      evaluateFeatureFlagFromMetadataSources(SYNTHETIC_FLAG, [
        {},
        { synthetic_flag: true },
      ]),
    ).toBe(true);
  });

  it('applies a config override regardless of metadata', async () => {
    const { evaluateFeatureFlagFromMetadata } =
      await importWithSyntheticConfig();

    expect(
      evaluateFeatureFlagFromMetadata(OVERRIDDEN_FLAG, {
        overridden_flag: false,
      }),
    ).toBe(true);
  });

  it('rejects unknown flags', async () => {
    const { evaluateFeatureFlagFromMetadata } =
      await importWithSyntheticConfig();

    expect(() =>
      evaluateFeatureFlagFromMetadata('missing_flag' as never, {}),
    ).toThrow('Unknown feature flag: missing_flag');
  });

  it('evaluates every configured flag from one metadata record', async () => {
    const { evaluateFeatureFlagsFromMetadata: evaluateAll } =
      await importWithSyntheticConfig();

    expect(evaluateAll({ synthetic_flag: true })).toEqual({
      synthetic_flag: true,
      overridden_flag: true,
    });
  });

  it('classifies configured metadata keys as feature flags', async () => {
    const { getBooleanMetadataDescriptorByKey } =
      await importWithSyntheticConfig();

    expect(getBooleanMetadataDescriptorByKey('synthetic_flag')).toEqual({
      kind: 'feature-flag',
      description: 'Synthetic flag for machinery tests',
      group: 'testing',
    });
    expect(
      getBooleanMetadataDescriptorByKey('synthetic_flag_legacy').kind,
    ).toBe('feature-flag');
    expect(getBooleanMetadataDescriptorByKey('unrelated_key')).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
  });
});
