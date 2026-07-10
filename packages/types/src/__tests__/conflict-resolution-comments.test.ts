import {
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
  formatConflictResolutionFailureComment,
  formatConflictResolutionSuccessComment,
  parseConflictResolutionSummary,
  readConflictResolutionSummary,
} from '../conflict-resolution-comments';

describe('conflict-resolution-comments', () => {
  it('parses the human-facing completion summary format', () => {
    const summary = parseConflictResolutionSummary(
      [
        'Resolved merge conflicts in:',
        '- `apps/api/src/file.ts`',
        '',
        "Decisions I'm not 100% sure:",
        '- Kept the incoming branch validation check.',
        '',
        'Warnings:',
        '- Imports were reordered.',
      ].join('\n'),
    );

    expect(summary).toEqual({
      resolvedFiles: ['apps/api/src/file.ts'],
      controversialDecisions: ['Kept the incoming branch validation check.'],
      warnings: ['Imports were reordered.'],
    });
  });

  it('parses the structured section variant', () => {
    const summary = parseConflictResolutionSummary(
      [
        'Resolved merge conflicts on this PR.',
        'RESOLVED_FILES:',
        '- packages/sdk/src/file.ts',
        'CONTROVERSIAL_DECISIONS:',
        '- none',
        'WARNINGS:',
        '- none',
      ].join('\n'),
    );

    expect(summary).toEqual({
      resolvedFiles: ['packages/sdk/src/file.ts'],
      controversialDecisions: [],
      warnings: [],
    });
  });

  it('returns null for unrelated text', () => {
    expect(parseConflictResolutionSummary('Opened a draft PR.')).toBeNull();
  });

  it('reads a stored summary from task run result', () => {
    expect(
      readConflictResolutionSummary({
        [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: {
          resolvedFiles: ['a.ts'],
          controversialDecisions: ['Decision'],
          warnings: ['Warning'],
        },
      }),
    ).toEqual({
      resolvedFiles: ['a.ts'],
      controversialDecisions: ['Decision'],
      warnings: ['Warning'],
    });
  });

  it('formats the simplified success comment', () => {
    expect(
      formatConflictResolutionSuccessComment({
        resolvedFiles: ['a.ts'],
        controversialDecisions: ['Picked the newer schema shape.'],
        warnings: ['Imports were reordered.'],
      }),
    ).toBe(
      [
        'Resolved merge conflicts in:',
        '- `a.ts`',
        '',
        "Decisions I'm not 100% sure:",
        '- Picked the newer schema shape.',
        '',
        'Warnings:',
        '- Imports were reordered.',
      ].join('\n'),
    );
  });

  it('formats the simplified failure comment', () => {
    expect(
      formatConflictResolutionFailureComment(
        'The automated resolution encountered an error.',
      ),
    ).toBe(
      [
        'I detected merge conflicts but could not automatically resolve them:',
        'The automated resolution encountered an error.',
      ].join('\n'),
    );
  });
});
