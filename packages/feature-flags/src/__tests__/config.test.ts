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

  it('CodeMode defaults to false and maps to the OpenCode env opt-in', () => {
    const config = FEATURE_FLAG_CONFIG[FeatureFlag.CodeMode];
    expect(config.defaultValue).toBe(false);
    expect(config.metadataKey).toBe('opencode_code_mode');
  });
});
