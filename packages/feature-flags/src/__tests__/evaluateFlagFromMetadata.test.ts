import {
  areDeploymentPreviewsEnabled,
  coerceToBoolean,
  evaluateFeatureFlagFromMetadataSources,
  evaluateFeatureFlagsFromMetadata,
  getDeploymentPreviewsEnabledSetting,
  normalizeMetadataRecord,
  setDeploymentPreviewsEnabled,
} from '../index';
import { FeatureFlag } from '../types';

describe('coerceToBoolean', () => {
  it('returns booleans unchanged', () => {
    expect(coerceToBoolean(true)).toBe(true);
    expect(coerceToBoolean(false)).toBe(false);
  });

  it('treats only "true" (case-insensitive) as true for strings', () => {
    expect(coerceToBoolean('true')).toBe(true);
    expect(coerceToBoolean('TRUE')).toBe(true);
    expect(coerceToBoolean('false')).toBe(false);
    expect(coerceToBoolean('yes')).toBe(false);
    expect(coerceToBoolean('')).toBe(false);
  });

  it('uses zero/non-zero semantics for numbers', () => {
    expect(coerceToBoolean(0)).toBe(false);
    expect(coerceToBoolean(1)).toBe(true);
    expect(coerceToBoolean(-1)).toBe(true);
  });

  it('falls back to JavaScript truthiness for other value types', () => {
    expect(coerceToBoolean(undefined)).toBe(false);
    expect(coerceToBoolean(null)).toBe(false);
    expect(coerceToBoolean([])).toBe(true);
    expect(coerceToBoolean({})).toBe(true);
  });

  it('prefers user metadata over org metadata when both define the same flag', () => {
    expect(
      evaluateFeatureFlagFromMetadataSources(FeatureFlag.SuggestionRouting, [
        { suggestion_routing: false },
        { suggestion_routing: true },
      ]),
    ).toBe(false);
  });

  it('falls back to org metadata when user metadata does not define the flag', () => {
    expect(
      evaluateFeatureFlagFromMetadataSources(FeatureFlag.SuggestionRouting, [
        {},
        { suggestion_routing: true },
      ]),
    ).toBe(true);
  });

  it('ignores invalid metadata sources instead of casting them', () => {
    expect(
      evaluateFeatureFlagFromMetadataSources(FeatureFlag.SuggestionRouting, [
        null,
        ['suggestion_routing'],
        'not metadata',
        { suggestion_routing: true },
      ]),
    ).toBe(true);
  });

  it('normalizes invalid public metadata to an empty object', () => {
    expect(normalizeMetadataRecord(null)).toEqual({});
    expect(normalizeMetadataRecord(['suggestion_routing'])).toEqual({});
    expect(normalizeMetadataRecord('not metadata')).toEqual({});
    expect(normalizeMetadataRecord({ suggestion_routing: true })).toEqual({
      suggestion_routing: true,
    });
  });

  it('evaluates all flags from a single metadata object', () => {
    const flags = evaluateFeatureFlagsFromMetadata({
      suggestion_routing: true,
    });

    expect(flags[FeatureFlag.SuggestionRouting]).toBe(true);
  });

  it('treats live previews as disabled unless explicitly set to true', () => {
    expect(areDeploymentPreviewsEnabled({})).toBe(false);
    expect(areDeploymentPreviewsEnabled({ previews_enabled: true })).toBe(true);
    expect(areDeploymentPreviewsEnabled({ previews_enabled: false })).toBe(
      false,
    );
    expect(
      getDeploymentPreviewsEnabledSetting({ previews_enabled: false }),
    ).toBe(false);
    expect(
      getDeploymentPreviewsEnabledSetting({ previews_enabled: 'false' }),
    ).toBeUndefined();
  });

  it('normalizes and updates deployment preview metadata safely', () => {
    expect(normalizeMetadataRecord(null)).toEqual({});
    expect(setDeploymentPreviewsEnabled({ chore_queue: true }, false)).toEqual({
      chore_queue: true,
      previews_enabled: false,
    });
  });

  it('evaluates all flags from invalid metadata as defaults', () => {
    const flags = evaluateFeatureFlagsFromMetadata(['suggestion_routing']);

    expect(flags[FeatureFlag.SuggestionRouting]).toBe(false);
  });
});
