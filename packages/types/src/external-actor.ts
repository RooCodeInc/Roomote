export const LINEAR_SESSION_ACTOR_PREFIX = 'linear-session:';
export const LINEAR_AGENT_ACTOR_ID = 'linear-agent';
export const LINEAR_AGENT_LABEL = 'Linear Agent';

export function isLinearSessionActor(
  externalId: string | null | undefined,
): boolean {
  return externalId?.startsWith(LINEAR_SESSION_ACTOR_PREFIX) ?? false;
}

export function normalizeExternalActorId(
  externalId: string | null | undefined,
): string | null {
  if (!externalId) {
    return null;
  }

  return isLinearSessionActor(externalId) ? LINEAR_AGENT_ACTOR_ID : externalId;
}

export function formatExternalActorLabel(input: {
  actorExternalId: string | null | undefined;
  actorDisplayName: string | null | undefined;
}): string | null {
  if (isLinearSessionActor(input.actorExternalId)) {
    return LINEAR_AGENT_LABEL;
  }

  return input.actorDisplayName ?? input.actorExternalId ?? null;
}
