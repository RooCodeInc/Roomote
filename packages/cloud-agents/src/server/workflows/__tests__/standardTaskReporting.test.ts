import { standardTask } from '../standardTask';

describe('standardTask reporting consumer', () => {
  it('gives Fast-owned coding tasks an internal factual report contract', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement the delegated change',
      repo: 'Roomote/example-app',
      reportConsumer: 'fast-orchestrator',
      codeReviewsEnabled: true,
    });

    expect(harnessInstructions).toContain(
      '<consumer>fast-orchestrator</consumer>',
    );
    expect(harnessInstructions).toContain(
      'Fast owns acknowledgements, progress updates, clarification, and final user communication.',
    );
    expect(harnessInstructions).toContain(
      'send Fast one internal closeout report using `send_chat_reply` with purpose `closeout`',
    );
    expect(harnessInstructions).toContain(
      'Include validation: commands or checks run, their outcomes, and material checks not run.',
    );
    expect(harnessInstructions).toContain(
      'Be complete but not transcript-like.',
    );
    expect(harnessInstructions).not.toContain('Slack-visible closeout');
    expect(harnessInstructions).not.toContain('Discord-visible closeout');
    expect(harnessInstructions).not.toContain(
      'acknowledge it immediately to the user',
    );
    expect(harnessInstructions).not.toContain('<user_input_elicitation>');
    expect(harnessInstructions).not.toContain(
      '<code_review_self_review_closeout>',
    );
  });

  it('keeps direct-user tasks free of the Fast reporting contract', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement the direct task',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).not.toContain('<reporting_context>');
    expect(harnessInstructions).not.toContain('fast-orchestrator');
    expect(harnessInstructions).not.toContain(
      'Fast owns acknowledgements, progress updates, clarification, and final user communication.',
    );
    expect(harnessInstructions).toContain(
      'acknowledge it immediately to the user',
    );
    expect(harnessInstructions).toContain('<user_input_elicitation>');
  });
});
