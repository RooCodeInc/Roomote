import { describe, expect, it } from 'vitest';

import {
  describeValidationError,
  describeValidationErrorMessage,
} from './validation-error';

describe('describeValidationErrorMessage', () => {
  it('renders a validation issue array as human-readable text', () => {
    const raw = JSON.stringify([
      {
        code: 'custom',
        message:
          'Extracted attachment text exceeds the 200,000 character limit',
        path: ['attachmentTexts'],
      },
    ]);

    expect(describeValidationErrorMessage(raw)).toBe(
      'attachmentTexts: Extracted attachment text exceeds the 200,000 character limit',
    );
  });

  it('renders nested paths and multiple issues', () => {
    const raw = JSON.stringify([
      {
        code: 'too_big',
        message: 'String must contain at most 8 character(s)',
        path: ['setupGuidance'],
      },
      {
        code: 'custom',
        message: 'Text or at least one attachment is required',
        path: ['text'],
      },
    ]);

    expect(describeValidationErrorMessage(raw)).toBe(
      'setupGuidance: String must contain at most 8 character(s)\ntext: Text or at least one attachment is required',
    );
  });

  it('leaves messages without a path as-is', () => {
    const raw = JSON.stringify([
      { code: 'custom', message: 'Something failed' },
    ]);

    expect(describeValidationErrorMessage(raw)).toBe('Something failed');
  });

  it('returns plain messages unchanged', () => {
    expect(describeValidationErrorMessage('turn is busy')).toBe('turn is busy');
  });
});

describe('describeValidationError', () => {
  it('describes a validation error from an Error instance', () => {
    const raw = JSON.stringify([
      {
        code: 'custom',
        message:
          'Extracted attachment text exceeds the 200,000 character limit',
        path: ['attachmentTexts'],
      },
    ]);

    expect(
      describeValidationError(new Error(raw), 'Failed to start session'),
    ).toBe(
      'attachmentTexts: Extracted attachment text exceeds the 200,000 character limit',
    );
  });

  it('uses the fallback for non-Error values', () => {
    expect(describeValidationError(null, 'Failed to start session')).toBe(
      'Failed to start session',
    );
    expect(describeValidationError(new Error(''), 'Failed')).toBe('Failed');
  });
});
