// pnpm --filter @roomote/cloud-agents test src/server/workflows/__tests__/githubPrReviewComment.test.ts

import {
  buildTerminalReviewStatus,
  buildTerminalReviewSummaryBody,
  buildReviewSummaryBody,
  REVIEW_STATUS_START_MARKER,
  REVIEW_STATUS_END_MARKER,
  REVIEW_CHECKLIST_START_MARKER,
  REVIEW_CHECKLIST_END_MARKER,
} from '../githubPrReviewComment';

const MARKER = (sha: string, mode = 'initial') =>
  `<!-- roomote-review-summary sha=${sha} mode=${mode} -->`;

const IN_PROGRESS_INITIAL =
  'Reviewing the PR now. <a href="https://openmote.dev/task/x" target="_blank" rel="noopener noreferrer">Follow</a>';

const IN_PROGRESS_SYNC = 'Re-reviewing new commits now.';

const COMPLETION =
  'No code issues found. [See task](https://openmote.dev/task/x)';

describe('buildTerminalReviewStatus', () => {
  const url = 'https://openmote.dev/task/abc';

  it('completed outcome includes a See task link', () => {
    expect(
      buildTerminalReviewStatus({ outcome: 'completed', taskUrl: url }),
    ).toBe(
      `Review complete. <a href="${url}" target="_blank" rel="noopener noreferrer">See task</a>`,
    );
  });

  it('failed outcome', () => {
    expect(
      buildTerminalReviewStatus({ outcome: 'failed', taskUrl: url }),
    ).toContain('Review could not be completed.');
  });

  it('canceled outcome', () => {
    expect(
      buildTerminalReviewStatus({ outcome: 'canceled', taskUrl: url }),
    ).toContain('Review was canceled.');
  });
});

describe('buildTerminalReviewSummaryBody', () => {
  const terminal = 'Review complete. See task';

  it('finalizes an in-progress initial summary, preserving the marker and checklist', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('abc123'),
      statusContent: IN_PROGRESS_INITIAL,
      checklistContent: '- [ ] Fix the thing\n- [x] Already addressed',
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).not.toBeNull();
    expect(updated!.startsWith(MARKER('abc123'))).toBe(true);
    expect(updated).toContain(
      `${REVIEW_STATUS_START_MARKER}\n${terminal}\n${REVIEW_STATUS_END_MARKER}`,
    );
    // Checklist history is preserved verbatim.
    expect(updated).toContain(
      `${REVIEW_CHECKLIST_START_MARKER}\n- [ ] Fix the thing\n- [x] Already addressed\n${REVIEW_CHECKLIST_END_MARKER}`,
    );
  });

  it('finalizes an in-progress sync summary', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('def456', 'sync'),
      statusContent: IN_PROGRESS_SYNC,
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).not.toBeNull();
    expect(updated!.startsWith(MARKER('def456', 'sync'))).toBe(true);
    expect(updated).toContain(terminal);
    expect(updated).not.toContain(IN_PROGRESS_SYNC);
  });

  it('does not clobber a comment the agent already finalized', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('abc123'),
      statusContent: COMPLETION,
    });

    expect(
      buildTerminalReviewSummaryBody({
        existingBody: existing,
        terminalStatus: terminal,
      }),
    ).toBeNull();
  });

  it('does not touch a comment without the review summary marker', () => {
    expect(
      buildTerminalReviewSummaryBody({
        existingBody: 'Some other comment body.',
        terminalStatus: terminal,
      }),
    ).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(
      buildTerminalReviewSummaryBody({
        existingBody: '',
        terminalStatus: terminal,
      }),
    ).toBeNull();
  });

  it('preserves the checklist when finalizing a sync comment that has one', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('def456', 'sync'),
      statusContent: IN_PROGRESS_SYNC,
      checklistContent: '- [ ] Surviving finding',
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).toContain('- [ ] Surviving finding');
  });
});
