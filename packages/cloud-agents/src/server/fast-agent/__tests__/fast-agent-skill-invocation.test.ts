import {
  buildFastAgentExplicitSkillInvocationContext,
  parseFastAgentExplicitSkillInvocation,
} from '../fast-agent-skill-invocation';

describe('Fast explicit skill invocation parsing', () => {
  it('recognizes a Slack mention followed by a skill in a long message', () => {
    const message = [
      'There is a lot of context before the actual request, including $120 in estimated impact.',
      'Please use the runbook below for the production report.',
      '<@ROOMOTE_ID> $handle-operations-ticket investigate the failed handoff',
    ].join('\n');

    expect(
      parseFastAgentExplicitSkillInvocation(message, 'slack', 'ROOMOTE_ID'),
    ).toBe('handle-operations-ticket');
    expect(
      buildFastAgentExplicitSkillInvocationContext(
        message,
        'slack',
        'ROOMOTE_ID',
      ),
    ).toBe('<explicit_skill_invocation name="handle-operations-ticket" />');
  });

  it('preserves leading explicit invocation behavior on every surface', () => {
    expect(
      parseFastAgentExplicitSkillInvocation(
        '$handle-operations-ticket investigate this',
        'web',
      ),
    ).toBe('handle-operations-ticket');
  });

  it.each([
    [
      'Slack dollar prose without a mention',
      'This costs $handle-operations-ticket today',
    ],
    [
      'a skill token separated from the mention by prose',
      '<@ROOMOTE_ID> please use $handle-operations-ticket',
    ],
    ['a numeric dollar token', '<@ROOMOTE_ID> $120 is the estimated impact'],
    ['a malformed slash name', '<@ROOMOTE_ID> $handle/operations-ticket now'],
    ['a quoted dollar token', '<@ROOMOTE_ID> "$handle-operations-ticket"'],
  ])('ignores %s', (_label, message) => {
    expect(
      parseFastAgentExplicitSkillInvocation(message, 'slack', 'ROOMOTE_ID'),
    ).toBeUndefined();
  });

  it('ignores another user mention followed by a skill when Roomote is mentioned elsewhere', () => {
    const message = [
      '<@ROOMOTE_ID> please review this conversation.',
      '<@U_OTHER> $handle-operations-ticket this is for you',
    ].join('\n');

    expect(
      parseFastAgentExplicitSkillInvocation(message, 'slack', 'ROOMOTE_ID'),
    ).toBeUndefined();
  });

  it('finds the verified Roomote invocation after another mention invocation', () => {
    const message = [
      '<@U_OTHER> $triage this is for you.',
      'More context follows before the Roomote request.',
      '<@ROOMOTE_ID> $handle-operations-ticket investigate the handoff',
    ].join('\n');

    expect(
      parseFastAgentExplicitSkillInvocation(message, 'slack', 'ROOMOTE_ID'),
    ).toBe('handle-operations-ticket');
  });

  it('requires the Roomote Slack user ID for mention-based invocation', () => {
    expect(
      parseFastAgentExplicitSkillInvocation(
        'Context <@ROOMOTE_ID> $handle-operations-ticket now',
        'slack',
      ),
    ).toBeUndefined();
  });

  it('does not apply Slack mention syntax on another surface', () => {
    expect(
      parseFastAgentExplicitSkillInvocation(
        'Context first <@ROOMOTE_ID> $handle-operations-ticket now',
        'discord',
        'ROOMOTE_ID',
      ),
    ).toBeUndefined();
  });
});
