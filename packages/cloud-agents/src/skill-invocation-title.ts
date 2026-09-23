import { PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS } from './packaged-skill-invocations';

const PACKAGED_INITIAL_SKILL_INVOCATION_SET = new Set<string>(
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS,
);

const LEADING_SKILL_INVOCATION_PATTERN = /^\s*[$/]([A-Za-z0-9._-]+)/u;
const LEADING_TITLE_SEPARATOR_PATTERN = /^\p{P}\s*/u;

export function matchInitialSkillInvocationPrefix(
  value: string,
): { skillName: string; matchedText: string } | null {
  const match = LEADING_SKILL_INVOCATION_PATTERN.exec(value);
  const skillName = match?.[1];

  return match && skillName ? { skillName, matchedText: match[0] } : null;
}

// This matches the authoritative packaged first-hop routing list. Repository-
// local skills are discovered later in the worker and cannot be resolved here.
export function isRecognizedInitialSkillInvocation({
  skillName,
}: {
  skillName: string;
}): boolean {
  return PACKAGED_INITIAL_SKILL_INVOCATION_SET.has(skillName);
}

/** Remove only recognized leading skill invocations from title-only text. */
export function stripRecognizedInitialSkillInvocationsForTitle(
  title: string,
): string {
  let cleanedTitle = title;
  let removedInvocation = false;

  while (true) {
    const match = matchInitialSkillInvocationPrefix(cleanedTitle);

    if (
      !match ||
      !isRecognizedInitialSkillInvocation({ skillName: match.skillName })
    ) {
      return removedInvocation ? cleanedTitle.trimStart() : cleanedTitle;
    }

    cleanedTitle = cleanedTitle.slice(match.matchedText.length);
    const separator = LEADING_TITLE_SEPARATOR_PATTERN.exec(cleanedTitle);
    if (separator) {
      cleanedTitle = cleanedTitle.slice(separator[0].length);
    }
    removedInvocation = true;
  }
}
