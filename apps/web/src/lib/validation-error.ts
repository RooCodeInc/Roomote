type RawValidationIssue = {
  message?: unknown;
  path?: unknown;
};

function isValidationIssueArray(value: unknown): value is RawValidationIssue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as RawValidationIssue).message === 'string',
    )
  );
}

function describeIssuePath(path: RawValidationIssue['path']): string | null {
  if (!Array.isArray(path) || path.length === 0) {
    return null;
  }

  return path
    .map((segment) =>
      typeof segment === 'string' || typeof segment === 'number'
        ? String(segment)
        : null,
    )
    .filter((segment): segment is string => segment !== null)
    .join('.');
}

/**
 * tRPC serializes zod validation failures as a raw JSON array of issues in the
 * error message. Turn that back into human-readable text; anything that does
 * not parse as an issue array is returned unchanged.
 */
export function describeValidationErrorMessage(message: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return message;
  }

  if (!isValidationIssueArray(parsed)) {
    return message;
  }

  return parsed
    .map((issue) => {
      const text = String(issue.message);
      const path = describeIssuePath(issue.path);
      return path ? `${path}: ${text}` : text;
    })
    .join('\n');
}

export function describeValidationError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return describeValidationErrorMessage(error.message);
  }

  return fallback;
}

function isAttachmentTextLimitMessage(message: string): boolean {
  return message.includes('attachment') && message.includes('character limit');
}

/**
 * Composer validation errors — attachment text limit failures and zod issue
 * arrays from the server — get the shared dialog; anything else keeps its
 * existing inline or toast surface.
 */
export function isComposerValidationError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }

  if (isAttachmentTextLimitMessage(error.message)) {
    return true;
  }

  try {
    return isValidationIssueArray(JSON.parse(error.message));
  } catch {
    return false;
  }
}

export function isAttachmentTextLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    isAttachmentTextLimitMessage(describeValidationErrorMessage(error.message))
  );
}
