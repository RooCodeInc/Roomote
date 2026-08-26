// pnpm --filter @roomote/cloud-agents test src/server/workflows/__tests__/githubPrReviewComment.test.ts

import {
  buildGithubCommitHref,
  buildInProgressReviewSummaryBody,
  buildReviewMetaFooter,
  buildTerminalReviewStatus,
  buildTerminalReviewSummaryBody,
  buildReviewSummaryBody,
  getReviewFooterPhase,
  getReviewSummaryMarkerPhase,
  isReviewSummaryInProgress,
  parseReviewSummaryMarkerSha,
  REVIEW_STATUS_START_MARKER,
  REVIEW_STATUS_END_MARKER,
  REVIEW_CHECKLIST_START_MARKER,
  REVIEW_CHECKLIST_END_MARKER,
} from '../githubPrReviewComment';

const MARKER = (sha: string, mode = 'initial') =>
  `<!-- roomote-review-summary sha=${sha} mode=${mode} -->`;

const IN_PROGRESS_INITIAL =
  'Reviewing the PR now. <a href="https://roomote.dev/task/x" target="_blank" rel="noopener noreferrer">Follow</a>';

const IN_PROGRESS_SYNC = 'Re-reviewing new commits now.';

const COMPLETION =
  'No code issues found. [See task](https://roomote.dev/task/x)';

describe('buildTerminalReviewStatus', () => {
  const url = 'https://roomote.dev/task/abc';

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

describe('review meta footer', () => {
  it('formats reviewing/reviewed footer with linked SHA', () => {
    const commitHref = buildGithubCommitHref({
      repositoryFullName: 'RooCodeInc/Roomote',
      sha: 'abc1234deadbeef',
    });

    expect(
      buildReviewMetaFooter({
        phase: 'Reviewing',
        sha: 'abc1234deadbeef',
        commitHref,
      }),
    ).toBe(
      `<sub>Reviewing <a href="https://github.com/RooCodeInc/Roomote/commit/abc1234deadbeef" target="_blank" rel="noopener noreferrer">abc1234</a></sub>`,
    );

    expect(
      buildReviewMetaFooter({
        phase: 'Reviewed',
        sha: 'abc1234deadbeef',
      }),
    ).toBe('<sub>Reviewed abc1234</sub>');
  });

  it('parses the marker SHA', () => {
    expect(parseReviewSummaryMarkerSha(MARKER('abcdef0123'))).toBe(
      'abcdef0123',
    );
  });

  it('uses the footer phase instead of relying on status prose', () => {
    const body = buildReviewSummaryBody({
      summaryMarker: MARKER('abc1234deadbeef'),
      statusContent: 'I am reviewing the updated PR head now.',
      metaPhase: 'Reviewing',
    });

    expect(getReviewFooterPhase(body)).toBe('Reviewing');
    expect(getReviewSummaryMarkerPhase(body)).toBe('Reviewing');
    expect(isReviewSummaryInProgress(body)).toBe(true);
    expect(body).toContain('version=2 phase=reviewing');
  });

  it('trusts a Reviewed footer over terminal prose that starts with Reviewing', () => {
    const body = buildReviewSummaryBody({
      summaryMarker: MARKER('abc1234deadbeef'),
      statusContent: 'Reviewing uncovered one actionable issue.',
      metaPhase: 'Reviewed',
    });

    expect(getReviewFooterPhase(body)).toBe('Reviewed');
    expect(getReviewSummaryMarkerPhase(body)).toBe('Reviewed');
    expect(isReviewSummaryInProgress(body)).toBe(false);
    expect(body).toContain('version=2 phase=reviewed');
  });

  it('trusts the hidden marker phase when presentation metadata disagrees', () => {
    const body = [
      '<!-- roomote-review-summary sha=abc1234 mode=sync version=2 phase=reviewing -->',
      REVIEW_STATUS_START_MARKER,
      'No code issues found.',
      REVIEW_STATUS_END_MARKER,
      '<sub>Reviewed abc1234</sub>',
    ].join('\n');

    expect(getReviewSummaryMarkerPhase(body)).toBe('Reviewing');
    expect(isReviewSummaryInProgress(body)).toBe(true);
  });

  it('ignores phase metadata from unsupported marker versions', () => {
    const body = [
      '<!-- roomote-review-summary sha=abc1234 mode=sync version=1 phase=reviewing -->',
      REVIEW_STATUS_START_MARKER,
      'No code issues found.',
      REVIEW_STATUS_END_MARKER,
      '<sub>Reviewed abc1234</sub>',
    ].join('\n');

    expect(getReviewSummaryMarkerPhase(body)).toBeUndefined();
    expect(isReviewSummaryInProgress(body)).toBe(false);
  });

  it('falls back to legacy status wording when no footer exists', () => {
    const body = [
      MARKER('abc1234deadbeef'),
      REVIEW_STATUS_START_MARKER,
      'I am reviewing the updated PR head now.',
      REVIEW_STATUS_END_MARKER,
    ].join('\n');

    expect(getReviewFooterPhase(body)).toBeUndefined();
    expect(isReviewSummaryInProgress(body)).toBe(true);
  });

  it('appends the footer at the bottom of the summary body', () => {
    const body = buildReviewSummaryBody({
      summaryMarker: MARKER('abc1234deadbeef'),
      statusContent: IN_PROGRESS_INITIAL,
      checklistContent: '- [ ] Fix the thing',
      repositoryFullName: 'RooCodeInc/Roomote',
    });

    expect(body.endsWith('</sub>')).toBe(true);
    expect(body).toContain('<sub>Reviewing ');
    expect(body).toContain('abc1234');
    expect(body).toContain(
      'href="https://github.com/RooCodeInc/Roomote/commit/abc1234deadbeef"',
    );
    expect(body).not.toContain('#abc1234');
    expect(body).not.toContain(' UTC');
    expect(body).not.toContain(' · ');
    expect(body.indexOf(REVIEW_CHECKLIST_END_MARKER)).toBeLessThan(
      body.indexOf('<sub>Reviewing '),
    );
  });

  it('keeps footer label and link on the preserved marker SHA during reuse', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('aaa1111deadbeef'),
      statusContent: COMPLETION,
      checklistContent: '- [ ] Prior finding',
      repositoryFullName: 'RooCodeInc/Roomote',
    });

    const updated = buildInProgressReviewSummaryBody({
      existingBody: existing,
      inProgressStatus: IN_PROGRESS_INITIAL,
      summaryMarker: MARKER('bbb2222cafebabe'),
      repositoryFullName: 'RooCodeInc/Roomote',
    });

    expect(updated).toContain(
      'sha=aaa1111deadbeef mode=initial version=2 phase=reviewing',
    );
    expect(updated).toContain('>aaa1111</a>');
    expect(updated).toContain(
      'href="https://github.com/RooCodeInc/Roomote/commit/aaa1111deadbeef"',
    );
    expect(updated).not.toContain('bbb2222');
  });
});

describe('buildTerminalReviewSummaryBody', () => {
  const terminal = 'Review complete. See task';

  it('finalizes an in-progress initial summary, preserving the marker and checklist', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('abc123f'),
      statusContent: IN_PROGRESS_INITIAL,
      checklistContent: '- [ ] Fix the thing\n- [x] Already addressed',
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).not.toBeNull();
    expect(updated).toContain(
      'sha=abc123f mode=initial version=2 phase=reviewed',
    );
    expect(updated).toContain(
      `${REVIEW_STATUS_START_MARKER}\n${terminal}\n${REVIEW_STATUS_END_MARKER}`,
    );
    // Checklist history is preserved verbatim.
    expect(updated).toContain(
      `${REVIEW_CHECKLIST_START_MARKER}\n- [ ] Fix the thing\n- [x] Already addressed\n${REVIEW_CHECKLIST_END_MARKER}`,
    );
    expect(updated).toContain('<sub>Reviewed abc123f</sub>');
  });

  it('finalizes an in-progress sync summary', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('def456f', 'sync'),
      statusContent: IN_PROGRESS_SYNC,
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).not.toBeNull();
    expect(updated).toContain('sha=def456f mode=sync version=2 phase=reviewed');
    expect(updated).toContain(terminal);
    expect(updated).not.toContain(IN_PROGRESS_SYNC);
    expect(updated).toContain('<sub>Reviewed def456f</sub>');
  });

  it('finalizes natural in-progress prose when the footer is Reviewing', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('def456f', 'sync'),
      statusContent: 'I am reviewing the updated PR head now.',
      metaPhase: 'Reviewing',
    });

    const updated = buildTerminalReviewSummaryBody({
      existingBody: existing,
      terminalStatus: terminal,
    });

    expect(updated).not.toBeNull();
    expect(updated).toContain(terminal);
    expect(updated).toContain('<sub>Reviewed def456f</sub>');
  });

  it('does not clobber a comment the agent already finalized', () => {
    const existing = buildReviewSummaryBody({
      summaryMarker: MARKER('abc123f'),
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
      summaryMarker: MARKER('def456f', 'sync'),
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
