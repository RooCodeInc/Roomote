import { describe, expect, it } from 'vitest';

import {
  coerceToBoolean,
  evaluateFeatureFlagsFromMetadata,
  normalizeMetadataRecord,
} from '../index';

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

  it('evaluates all flags to an empty object even with stale metadata', () => {
    expect(
      evaluateFeatureFlagsFromMetadata({
        slack_eval_launcher: true,
        show_debug_ui_setting: true,
        suggestion_routing: true,
        visual_proof_auto_screencast: true,
        background_subagents: true,
        opencode_code_mode: true,
      }),
    ).toEqual({});
  });
});
