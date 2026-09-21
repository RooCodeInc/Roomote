import { describe, expect, it } from 'vitest';

import {
  describeValidationError,
  describeValidationErrorMessage,
  isAttachmentTextLimitError,
  isComposerValidationError,
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

describe('isComposerValidationError', () => {
  it('detects attachment limit errors', () => {
    expect(
      isComposerValidationError(
        new Error(
          'Extracted text from "notes.txt" would exceed the 200,000 character limit for attachments (total 200,001 characters). Remove or shorten the attachment and try again.',
        ),
      ),
    ).toBe(true);
  });

  it('detects zod validation issue arrays', () => {
    expect(
      isComposerValidationError(
        new Error(
          JSON.stringify([
            {
              code: 'custom',
              message:
                'Extracted attachment text exceeds the 200,000 character limit',
              path: ['attachmentTexts'],
            },
          ]),
        ),
      ),
    ).toBe(true);
  });

  it('rejects ordinary errors', () => {
    expect(isComposerValidationError(new Error('turn is busy'))).toBe(false);
    expect(isComposerValidationError('turn is busy')).toBe(false);
    expect(isComposerValidationError(null)).toBe(false);
  });
});

describe('isAttachmentTextLimitError', () => {
  it('detects the server-side limit message through a validation issue array', () => {
    expect(
      isAttachmentTextLimitError(
        new Error(
          JSON.stringify([
            {
              code: 'custom',
              message:
                'Extracted attachment text exceeds the 200,000 character limit',
              path: ['attachmentTexts'],
            },
          ]),
        ),
      ),
    ).toBe(true);
  });

  it('detects the client-side limit message', () => {
    expect(
      isAttachmentTextLimitError(
        new Error(
          'Extracted text from "notes.txt" would exceed the 200,000 character limit for attachments (total 200,001 characters). Remove or shorten the attachment and try again.',
        ),
      ),
    ).toBe(true);
    expect(isAttachmentTextLimitError(new Error('turn is busy'))).toBe(false);
  });
});
