import type { FastAgentSurface } from './fast-agent-conversation';

const SKILL_INVOCATION_NAME = String.raw`([A-Za-z][A-Za-z0-9._-]*)`;
const LEADING_SKILL_INVOCATION_PATTERN = new RegExp(
  String.raw`^\s*\$${SKILL_INVOCATION_NAME}(?=$|\s)`,
  'u',
);
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function parseFastAgentExplicitSkillInvocation(
  text: string,
  surface: FastAgentSurface,
  slackRoomoteUserId?: string,
): string | undefined {
  const leading = LEADING_SKILL_INVOCATION_PATTERN.exec(text)?.[1];
  if (leading) return leading;
  if (surface !== 'slack' || !slackRoomoteUserId) return undefined;
  const roomoteMentionInvocationPattern = new RegExp(
    String.raw`(?:^|\s)<@${escapeRegExp(slackRoomoteUserId)}>\s+\$${SKILL_INVOCATION_NAME}(?=$|\s)`,
    'u',
  );
  return roomoteMentionInvocationPattern.exec(text)?.[1];
}

export function buildFastAgentExplicitSkillInvocationContext(
  text: string,
  surface: FastAgentSurface,
  slackRoomoteUserId?: string,
): string | undefined {
  const invocation = parseFastAgentExplicitSkillInvocation(
    text,
    surface,
    slackRoomoteUserId,
  );
  return invocation
    ? `<explicit_skill_invocation name="${invocation}" />`
    : undefined;
}
