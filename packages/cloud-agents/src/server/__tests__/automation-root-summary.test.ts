import { buildManagerAutomationRootSummaryPromptContract } from '../automation-root-summary';

describe('buildManagerAutomationRootSummaryPromptContract', () => {
  it('keeps automation summaries focused on results', () => {
    const prompt = buildManagerAutomationRootSummaryPromptContract({
      detailLabel: 'actions',
      highlightLabel: 'findings worth attention',
    });

    expect(prompt).toContain(
      'Lead with the result, not the work performed to produce it.',
    );
    expect(prompt).toContain(
      'Do not mention the scan, review, pass, automation, schedule, task, or investigation process.',
    );
    expect(prompt).toContain(
      'Keep it concise and natural. It should feel like a teammate sharing results, not a process update.',
    );
    expect(prompt).toContain(
      'Highlight the top 1 or 2 findings worth attention.',
    );
    expect(prompt).toContain(
      'End by pointing readers to the thread for the remaining actions.',
    );
  });
});
