export const HOME_PROMPT_PLACEHOLDERS = [
  'Find a TODO in the code and fix it',
  'Try a different design for our home page',
  'Fix the following bug as reported by a user:',
  'Review this pull request and address the feedback',
  'Investigate why this test is flaky and fix it',
  'Write the first pass of this feature and add the missing tests',
] as const;

export function normalizeHomePromptPlaceholderIndex(index: number): number {
  return (
    ((Math.floor(index) % HOME_PROMPT_PLACEHOLDERS.length) +
      HOME_PROMPT_PLACEHOLDERS.length) %
    HOME_PROMPT_PLACEHOLDERS.length
  );
}

export function getRandomHomePromptPlaceholderIndex(): number {
  return Math.floor(Math.random() * HOME_PROMPT_PLACEHOLDERS.length);
}
