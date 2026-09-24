const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Appends the requester's own words from the current turn to a delegated
 * task brief. The Fast agent writes the brief, and a condensed brief can drop
 * exact wording, layout, and component choices the requester spelled out; the
 * coding task needs the original message to build what was asked. Requests
 * the brief already quotes in full are not repeated.
 */
export function appendOriginalRequestToTaskText({
  text,
  requests,
}: {
  text: string;
  requests: readonly string[];
}): string {
  const baseText = text.trim();
  const normalizedBase = normalizeWhitespace(baseText);
  const seen = new Set<string>();
  const forwarded = requests
    .map((request) => request.trim())
    .filter((request) => {
      const normalized = normalizeWhitespace(request);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return !normalizedBase.includes(normalized);
    });

  if (forwarded.length === 0) return baseText;

  return [
    baseText,
    [
      '<original_request>',
      "The requester's own words from the conversation that produced this brief, forwarded verbatim. The brief above sets this task's scope. Within that scope, follow these words for exact requirements, wording, layout, and component choices the brief may have condensed; where they conflict with the brief, the requester's words win.",
      ...forwarded.map((request) => `<message>\n${request}\n</message>`),
      '</original_request>',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}
