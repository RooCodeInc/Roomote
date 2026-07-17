import {
  getBooleanMetadataDescriptorByKey,
  getFeatureFlagDescriptionByMetadataKey,
} from '../index';

describe('getFeatureFlagDescriptionByMetadataKey', () => {
  it('treats untyped boolean metadata keys as legacy by default', () => {
    expect(getFeatureFlagDescriptionByMetadataKey('analytics_page')).toBe(null);
    expect(getBooleanMetadataDescriptorByKey('analytics_page')).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
    expect(getFeatureFlagDescriptionByMetadataKey('thin_proof_capture')).toBe(
      null,
    );
    expect(
      getFeatureFlagDescriptionByMetadataKey('slack_solo_thread_replies'),
    ).toBeNull();
    expect(getFeatureFlagDescriptionByMetadataKey('random_harness')).toBeNull();
    expect(getBooleanMetadataDescriptorByKey('random_harness')).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
  });

  it('treats the retired previews_enabled deployment control as legacy', () => {
    expect(getFeatureFlagDescriptionByMetadataKey('previews_enabled')).toBe(
      null,
    );
    expect(getBooleanMetadataDescriptorByKey('previews_enabled')).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
  });

  it('returns descriptions for active boolean metadata controls outside the typed flag enum', () => {
    expect(getFeatureFlagDescriptionByMetadataKey('deployment_disabled')).toBe(
      'Disable Roomote access and new task launches for this deployment',
    );
    expect(getBooleanMetadataDescriptorByKey('deployment_disabled')).toEqual({
      kind: 'deployment-control',
      description:
        'Disable Roomote access and new task launches for this deployment',
      group: null,
    });
  });

  it('returns null for unknown metadata keys', () => {
    expect(getFeatureFlagDescriptionByMetadataKey('totally_unknown_flag')).toBe(
      null,
    );
    expect(getBooleanMetadataDescriptorByKey('totally_unknown_flag')).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
  });
});
