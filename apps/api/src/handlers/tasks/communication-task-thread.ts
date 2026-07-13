/**
 * Build the provisional conversation title used before the canonical task
 * title is generated. Providers may impose a smaller limit at the call site.
 */
export function buildCommunicationTaskThreadName(
  description: string,
  maxLength = 96,
): string {
  const normalized = description.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized || 'Roomote task');

  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : characters.join('');
}
