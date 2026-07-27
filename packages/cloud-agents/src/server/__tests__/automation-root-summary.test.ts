import { buildManagerAutomationRootSummaryPromptContract } from '../automation-root-summary';

describe('buildManagerAutomationRootSummaryPromptContract', () => {
  it('pushes the opening toward organic, varied investigation summaries', () => {
    const prompt = buildManagerAutomationRootSummaryPromptContract({
      detailLabel: 'actions',
      highlightLabel: 'findings worth attention',
      openerSignal: 'a Sentry scan or triage pass',
      openerExamples: [
        'I just did a quick Sentry scan',
        'I took a pass through Sentry',
      ],
    });

    expect(prompt).toContain(
      'Make the opening sentence clearly reveal that this was a Sentry scan or triage pass.',
    );
    expect(prompt).toContain(
      'Do that in the opening sentence itself, not later in the message.',
    );
    expect(prompt).toContain(
      'The opening should sound like a coworker giving a quick investigation update, not like an automation label or a status report.',
    );
    expect(prompt).toContain(
      'Hint at what the automation just did by describing the pass itself rather than naming the automation formally.',
    );
    expect(prompt).toContain(
      'Keep the pass reference conversational instead of writing the automation name like a label.',
    );
    expect(prompt).toContain(
      'Good opener territory for this run includes phrases like "I just did a quick Sentry scan", "I took a pass through Sentry".',
    );
    expect(prompt).toContain(
      'First-person phrasing is fine when it helps the message feel natural.',
    );
    expect(prompt).toContain(
      'Vary the cadence and phrasing across runs. Do not default to the same opener shape every time.',
    );
    expect(prompt).toContain(
      'do not lead with "The [automation name] automation..." unless clarity truly requires it.',
    );
    expect(prompt).toContain(
      'Highlight the top 1 or 2 findings worth attention.',
    );
    expect(prompt).toContain(
      'End by pointing readers to the thread for the remaining actions.',
    );
  });
});
