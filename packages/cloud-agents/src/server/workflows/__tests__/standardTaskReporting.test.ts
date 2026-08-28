import { getTaskReportConsumerFromPayload } from '@roomote/types';

import { standardTask } from '../standardTask';

describe('standardTask reporting consumer', () => {
  it('normalizes the legacy persisted consumer value', () => {
    expect(
      getTaskReportConsumerFromPayload({
        reportConsumer: 'fast-orchestrator',
      }),
    ).toBe('orchestrator');
  });

  it('recovers the automation consumer from legacy payload markers', () => {
    expect(
      getTaskReportConsumerFromPayload({
        customAutomationId: 'automation-1',
      }),
    ).toBe('automation');
    expect(
      getTaskReportConsumerFromPayload({
        backgroundAutomationKey: 'announcer',
      }),
    ).toBe('automation');
  });

  it('gives orchestrator-owned coding tasks an internal factual report contract', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement the delegated change',
      repo: 'Roomote/example-app',
      reportConsumer: 'orchestrator',
      codeReviewsEnabled: true,
    });

    expect(harnessInstructions).toContain('<consumer>orchestrator</consumer>');
    expect(harnessInstructions).toContain(
      '<role>You are the coding executor for an orchestrator-owned task.</role>',
    );
    expect(harnessInstructions).toContain(
      '<destination>All task communication is private input to the orchestrator. The orchestrator owns acknowledgements, progress updates, clarification, and final user communication.</destination>',
    );
    expect(harnessInstructions).toContain(
      '<delivery>Before settlement, send one report to the orchestrator using `send_chat_reply` with purpose `closeout`.</delivery>',
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
      '<scope>The report covers the final consequential state and gives the orchestrator enough factual context to close out the task without further inspection.</scope>',
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
    expect(reportingContext).not.toContain('Fast');
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

  it('keeps direct-user tasks free of the orchestrator report contract', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement the direct task',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).not.toContain('<reporting_context>');
    expect(harnessInstructions).not.toContain(
      '<consumer>orchestrator</consumer>',
    );
    expect(harnessInstructions).not.toContain(
      'The orchestrator owns acknowledgements, progress updates, clarification, and final user communication.',
    );
    expect(harnessInstructions).toContain(
      'acknowledge it immediately to the user',
    );
    expect(harnessInstructions).toContain('<user_input_elicitation>');
  });

  it('keeps initial automation reports quiet without overriding final delivery', () => {
    const { harnessInstructions } = standardTask({
      description: 'Scan repositories and report actionable findings',
      repo: 'Roomote/example-app',
      taskSurface: 'slack',
      reportConsumer: 'automation',
    });

    expect(harnessInstructions).toContain('<consumer>automation</consumer>');
    expect(harnessInstructions).toContain(
      'Its initial turn was not directed by a chat user.',
    );
    expect(harnessInstructions).toContain(
      'Keep initial acknowledgements, reactions, progress updates, partial findings, and routine status in the web task.',
    );
    expect(harnessInstructions).toContain(
      'The automation-specific prompt is authoritative for whether to report, where to report, which communication tools to use, and the number and shape of final messages.',
    );
    expect(harnessInstructions).toContain(
      'A directed user follow-up starts a normal channel lifecycle for that turn',
    );
    expect(harnessInstructions).not.toContain(
      '<consumer>orchestrator</consumer>',
    );
    expect(harnessInstructions).not.toContain(
      'This run was launched from a Slack conversation surface',
    );
  });
});
