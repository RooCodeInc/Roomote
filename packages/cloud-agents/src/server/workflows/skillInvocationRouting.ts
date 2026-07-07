export { PACKAGED_BETA_CHORE_SKILL_INVOCATIONS } from '../../packaged-skill-invocations';

import { PACKAGED_SKILL_INVOCATIONS } from '../../packaged-skill-invocations';

const PACKAGED_SKILL_INVOCATION_SET = new Set<string>(
  PACKAGED_SKILL_INVOCATIONS,
);

// This only governs authoritative Roomote-packaged first-hop routing in
// `standardTask()`. Explicit repo-local skill invocations are resolved later
// from the worker's discovered repo-local skill catalog instead of this
// hardcoded packaged-skill list.
export function isRecognizedInitialSkillInvocation({
  skillName,
}: {
  skillName: string;
}) {
  return PACKAGED_SKILL_INVOCATION_SET.has(skillName);
}
