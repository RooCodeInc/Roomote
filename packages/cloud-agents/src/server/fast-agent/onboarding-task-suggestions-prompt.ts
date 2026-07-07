function formatRepositoryLines(repositoryFullNames: string[]): string {
  return repositoryFullNames
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');
}

export function buildOnboardingTaskSuggestionsResearchSystemPrompt({
  repositoryFullNames,
}: {
  repositoryFullNames: string[];
}): string {
  return `You are Roomote Fast generating first-task suggestions for a newly onboarded engineering team.

Selected repositories:
${formatRepositoryLines(repositoryFullNames)}

How to work:
- Use the GitHub MCP tools before deciding on suggestions.
- Search code, read files, inspect issues, and check the current implementation details that support your choices.
- Ground every suggestion in what actually exists in these repositories today.
- Prefer small, high-confidence tasks that fit in a single Roomote task and can be validated locally.
- Prefer suggestions that deliver value quickly for a team seeing Roomote for the first time.
- Diversify the set when possible across quality, UX, developer workflow, reliability, or backlog cleanup.
- Avoid major migrations, large refactors, vague audits, credential-blocked work, or tasks that depend on unrecoverable product decisions.
- Do not ask follow-up questions.
- Do not mention your research process in the final answer.

Return concise research notes only. Include:
- the concrete files, issues, tests, or gaps you inspected
- 4-6 candidate task ideas grounded in that evidence
- why each idea is a good onboarding task for this repository set`;
}

export function buildOnboardingTaskSuggestionsResearchPrompt({
  repositoryFullNames,
  setupGuidance,
}: {
  repositoryFullNames: string[];
  setupGuidance: string | null;
}): string {
  const guidanceBlock = setupGuidance
    ? `\nSetup guidance from the admin:\n${setupGuidance.trim()}\n`
    : '';

  return `Generate the best first-task suggestions for this repository set:\n${formatRepositoryLines(
    repositoryFullNames,
  )}${guidanceBlock}\nUse the GitHub tools to inspect the repositories before you answer.`;
}

export function buildOnboardingTaskSuggestionsObjectSystemPrompt(): string {
  return `You convert repository research into structured onboarding task suggestions.

Requirements:
- Return exactly 4 suggestions.
- Each title must be concise, action-oriented, and at most 120 characters.
- Each brief must be self-contained and contain exactly four lines in this exact order:
  Goal: ...
  Why it matters: ...
  Scope: ...
  Success criteria: ...
- Prefer suggestions that are small, concrete, and grounded in the provided repository research.
- Avoid overlapping suggestions, generic audits, and large refactors.`;
}

export function buildOnboardingTaskSuggestionsObjectPrompt({
  repositoryFullNames,
  setupGuidance,
  repositoryResearch,
}: {
  repositoryFullNames: string[];
  setupGuidance: string | null;
  repositoryResearch: string;
}): string {
  const guidanceBlock = setupGuidance
    ? `Setup guidance from the admin:\n${setupGuidance.trim()}\n\n`
    : '';

  return `Selected repositories:
${formatRepositoryLines(repositoryFullNames)}

${guidanceBlock}Repository research:
${repositoryResearch.trim()}

Return the final onboarding task suggestion batch.`;
}
