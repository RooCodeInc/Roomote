import {
  isFastCommandInvocation,
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
    expect(isFastCommandInvocation('<@U_BOT> can you help with this?')).toBe(
      false,
    );
  });
});
