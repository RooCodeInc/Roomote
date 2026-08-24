/** Collapse whitespace runs, trim, and cap at `maxLength` with an ellipsis. */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  const normalized = text.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}
