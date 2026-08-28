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
      '<role>You are the coding executor for a Fast-owned task.</role>',
    );
    expect(harnessInstructions).toContain(
      '<destination>All task communication is private orchestrator input to Fast. Fast owns acknowledgements, progress updates, clarification, and final user communication.</destination>',
    );
    expect(harnessInstructions).toContain(
      '<delivery>Before settlement, send one report to Fast using `send_chat_reply` with purpose `closeout`.</delivery>',
    );
    for (const section of [
      'Outcome',
      'Changes',
      'Validation',
      'Artifacts',
      'Risks and caveats',
      'Recommended follow-ups',
    ]) {
      expect(harnessInstructions).toContain(`<section name="${section}">`);
    }
    expect(harnessInstructions).toContain(
      '<scope>The report covers the final consequential state and gives Fast enough factual context to close out the task without further inspection.</scope>',
    );
    expect(harnessInstructions).toContain(
      '<scope>The report is a concise factual summary organized by the required sections.</scope>',
    );
    const reportingContextStart = harnessInstructions.indexOf(
      '<reporting_context>',
    );
    const reportingContextEnd = harnessInstructions.indexOf(
      '</reporting_context>',
      reportingContextStart,
    );
    expect(reportingContextStart).toBeGreaterThanOrEqual(0);
    expect(reportingContextEnd).toBeGreaterThan(reportingContextStart);
    const reportingContext = harnessInstructions.slice(
      reportingContextStart,
      reportingContextEnd + '</reporting_context>'.length,
    );
    expect(reportingContext).not.toContain('Do not');
    expect(reportingContext).not.toContain('not user-facing');
    expect(reportingContext).not.toContain('not transcript-like');
    expect(reportingContext).not.toContain('unless');
    expect(reportingContext).not.toContain('outside the report scope');
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
