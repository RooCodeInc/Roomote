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
