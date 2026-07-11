import { FEATURE_FLAG_CONFIG } from '../config';
import { FeatureFlag } from '../types';

describe('FEATURE_FLAG_CONFIG', () => {
  it('has a config entry for every FeatureFlag enum value', () => {
    for (const flag of Object.values(FeatureFlag)) {
      expect(FEATURE_FLAG_CONFIG[flag]).toBeDefined();
      expect(FEATURE_FLAG_CONFIG[flag].metadataKey).toBeDefined();
    }
  });

  it('ShowDebugUISetting defaults to false', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.ShowDebugUISetting];
    expect(config.defaultValue).toBe(false);
    expect(config.metadataKey).toBe('show_debug_ui_setting');
  });

  it('PlanMode defaults to true', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.PlanMode];
    expect(config.defaultValue).toBe(true);
    expect(config.metadataKey).toBe('plan_mode');
  });

  it('VisualProofAutoScreencast defaults to false', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.VisualProofAutoScreencast];
    expect(config.defaultValue).toBe(false);
    expect(config.metadataKey).toBe('visual_proof_auto_screencast');
  });

  it('SuggestionRouting defaults to false', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.SuggestionRouting];
    expect(config.defaultValue).toBe(false);
    expect(config.metadataKey).toBe('suggestion_routing');
  });

  it('BackgroundSubagents defaults to false with the metadata opt-in intact', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.BackgroundSubagents];
    expect(config.defaultValue).toBe(false);
    expect(config.metadataKey).toBe('background_subagents');
    expect(config.legacyMetadataKeys).toEqual([
      'opencode_background_subagents',
    ]);
  });
});
