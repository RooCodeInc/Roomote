import {
  MAX_SWITCHABLE_MODEL_IDS,
  SWITCHABLE_MODELS_ENV_VAR_NAME,
  formatModelSwitchNoticeText,
  getModelSwitchNoticeFromMessageData,
  MODEL_SWITCH_NOTICE_PAYLOAD_KEY,
  parseModelSwitchNotice,
  parseSwitchableModelIds,
} from '../index';

describe('parseSwitchableModelIds', () => {
  it('parses, trims, and dedupes the comma-separated list', () => {
    expect(
      parseSwitchableModelIds(
        ' openrouter/anthropic/claude-opus-5 , anthropic/claude-opus-5,openrouter/anthropic/claude-opus-5 ',
      ),
    ).toEqual([
      'openrouter/anthropic/claude-opus-5',
      'anthropic/claude-opus-5',
    ]);
  });

  it('treats missing and empty values as no switchable models', () => {
    expect(parseSwitchableModelIds(undefined)).toEqual([]);
    expect(parseSwitchableModelIds(null)).toEqual([]);
    expect(parseSwitchableModelIds('')).toEqual([]);
    expect(parseSwitchableModelIds(' , , ')).toEqual([]);
  });

  it('exposes a stable env var name and bound', () => {
    expect(SWITCHABLE_MODELS_ENV_VAR_NAME).toBe('R_SWITCHABLE_MODELS');
    expect(MAX_SWITCHABLE_MODEL_IDS).toBeGreaterThan(0);
  });
});

describe('parseModelSwitchNotice', () => {
  it('parses a user switch with attribution', () => {
    expect(
      parseModelSwitchNotice({
        reason: 'user',
        fromModel: 'openrouter/anthropic/claude-opus-5',
        toModel: 'anthropic/claude-opus-5',
        requestedBy: 'Ada',
      }),
    ).toEqual({
      reason: 'user',
      fromModel: 'openrouter/anthropic/claude-opus-5',
      toModel: 'anthropic/claude-opus-5',
      requestedBy: 'Ada',
    });
  });

  it('parses a failover switch without a previous model', () => {
    expect(
      parseModelSwitchNotice({
        reason: 'failover',
        toModel: 'anthropic/claude-opus-5',
      }),
    ).toEqual({ reason: 'failover', toModel: 'anthropic/claude-opus-5' });
  });

  it('rejects unknown reasons and missing targets', () => {
    expect(
      parseModelSwitchNotice({ reason: 'other', toModel: 'a/b' }),
    ).toBeNull();
    expect(parseModelSwitchNotice({ reason: 'user' })).toBeNull();
    expect(
      parseModelSwitchNotice({ reason: 'user', toModel: '  ' }),
    ).toBeNull();
    expect(parseModelSwitchNotice(null)).toBeNull();
  });

  it('reads the notice off message data', () => {
    expect(
      getModelSwitchNoticeFromMessageData({
        [MODEL_SWITCH_NOTICE_PAYLOAD_KEY]: {
          reason: 'failover',
          toModel: 'anthropic/claude-opus-5',
        },
      }),
    ).toEqual({ reason: 'failover', toModel: 'anthropic/claude-opus-5' });
    expect(getModelSwitchNoticeFromMessageData(undefined)).toBeNull();
    expect(getModelSwitchNoticeFromMessageData({})).toBeNull();
  });
});

describe('formatModelSwitchNoticeText', () => {
  it('distinguishes an operator switch from a failover', () => {
    expect(
      formatModelSwitchNoticeText({
        reason: 'user',
        fromModel: 'openrouter/anthropic/claude-opus-5',
        toModel: 'anthropic/claude-opus-5',
        requestedBy: 'Ada',
      }),
    ).toBe(
      'Model changed by Ada from `openrouter/anthropic/claude-opus-5` to `anthropic/claude-opus-5`.',
    );

    expect(
      formatModelSwitchNoticeText({
        reason: 'failover',
        fromModel: 'openrouter/anthropic/claude-opus-5',
        toModel: 'anthropic/claude-opus-5',
      }),
    ).toBe(
      'Switched from `openrouter/anthropic/claude-opus-5` to `anthropic/claude-opus-5` after a provider failure.',
    );
  });

  it('omits attribution and origin when they are unknown', () => {
    expect(
      formatModelSwitchNoticeText({
        reason: 'user',
        toModel: 'anthropic/claude-opus-5',
      }),
    ).toBe('Model changed to `anthropic/claude-opus-5`.');
  });
});
