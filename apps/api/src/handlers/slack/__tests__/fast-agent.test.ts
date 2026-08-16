import {
  extractFastQuestion,
  isFastCommandInvocation,
  resolveFastAgentEntryMode,
  stripLeadingFastCommandMention,
} from '../events/fast-agent';

describe('Slack fast-agent helpers', () => {
  it('strips only the leading mention before parsing !fast', () => {
    expect(
      stripLeadingFastCommandMention('<@U_BOT>: !fast what file owns this?'),
    ).toBe('!fast what file owns this?');
  });

  it('detects fresh !fast commands after the leading mention is removed', () => {
    expect(isFastCommandInvocation('<@U_BOT> !fast what file owns this?')).toBe(
      true,
    );
    expect(isFastCommandInvocation('!fast What is 17 × 23?')).toBe(true);
    expect(isFastCommandInvocation('<@U_BOT> can you help with this?')).toBe(
      false,
    );
  });

  it('accepts ordinary text when continuing a fast thread', () => {
    expect(extractFastQuestion('Good, tired', true)).toBe('Good, tired');
    expect(extractFastQuestion('   ', true)).toBeNull();
    expect(extractFastQuestion('Good, tired')).toBeNull();
  });

  it('keeps ordinary messages on standard routing when the deployment flag is disabled', () => {
    expect(
      resolveFastAgentEntryMode({
        text: 'please fix this',
        deploymentSettingEnabled: false,
        userDefaultEnabled: true,
      }),
    ).toBeNull();
  });

  it('keeps ordinary messages on standard routing when the user setting is off', () => {
    expect(
      resolveFastAgentEntryMode({
        text: 'please fix this',
        deploymentSettingEnabled: true,
        userDefaultEnabled: false,
      }),
    ).toBeNull();
  });

  it('defaults ordinary messages to fast mode when both settings are enabled', () => {
    expect(
      resolveFastAgentEntryMode({
        text: 'please fix this',
        deploymentSettingEnabled: true,
        userDefaultEnabled: true,
      }),
    ).toBe('default');
  });

  it('preserves explicit !fast routing regardless of the user setting', () => {
    expect(
      resolveFastAgentEntryMode({
        text: '!fast please fix this',
        deploymentSettingEnabled: true,
        userDefaultEnabled: true,
      }),
    ).toBe('explicit');
  });
});
