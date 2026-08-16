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

  it('detects canonical /fast commands and the legacy !fast alias', () => {
    expect(isFastCommandInvocation('<@U_BOT> /fast what file owns this?')).toBe(
      true,
    );
    expect(isFastCommandInvocation('/fast What is 17 × 23?')).toBe(true);
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

  it('extracts questions from both fast command forms', () => {
    expect(extractFastQuestion('/fast ship this')).toBe('ship this');
    expect(extractFastQuestion('!fast ship this')).toBe('ship this');
  });

  it('keeps ordinary messages on standard routing when the deployment flag is disabled', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: false,
        deploymentSettingEnabled: false,
        userDefaultEnabled: true,
      }),
    ).toBeNull();
  });

  it('keeps ordinary messages on standard routing when the user setting is off', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: false,
        deploymentSettingEnabled: true,
        userDefaultEnabled: false,
      }),
    ).toBeNull();
  });

  it('defaults ordinary messages to fast mode when both settings are enabled', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: false,
        deploymentSettingEnabled: true,
        userDefaultEnabled: true,
      }),
    ).toBe('default');
  });

  it('preserves explicit !fast routing regardless of the user setting', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: true,
        deploymentSettingEnabled: true,
        userDefaultEnabled: true,
      }),
    ).toBe('explicit');
  });
});
