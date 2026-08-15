/**
 * Task creator filter encoding.
 *
 * Filter values encode the task initiator columns without an attribution
 * cascade:
 *
 * - `<userId>`                        linked human initiator (initiatorUserId)
 * - `automation:<key>`                automation initiator (initiatorAutomation)
 * - `automation:<key>:<encoded externalId>` one automation actor
 *                                            (actorExternalId)
 * - `external:<encoded externalId>`   unlinked external human actor
 *                                     (initiatorKind 'user' + actorExternalId)
 */

import {
  LINEAR_AGENT_ACTOR_ID,
  normalizeExternalActorId,
} from '@roomote/types';

const AUTOMATION_CREATOR_FILTER_PREFIX = 'automation:';
const EXTERNAL_CREATOR_FILTER_PREFIX = 'external:';

type ParsedCreatorFilterValue =
  | {
      kind: 'user';
      userId: string;
    }
  | {
      kind: 'automation';
      key: string;
      externalId?: string;
    }
  | {
      kind: 'external';
      externalId: string;
    }
  | {
      kind: 'linearAgent';
    };

export function buildCreatorFilterValue(input: {
  initiatorKind: 'user' | 'automation' | null | undefined;
  initiatorUserId: string | null | undefined;
  initiatorAutomation: string | null | undefined;
  actorExternalId: string | null | undefined;
}): string | null {
  if (input.initiatorKind === 'automation') {
    if (!input.initiatorAutomation) {
      return null;
    }

    const externalId = normalizeExternalActorId(input.actorExternalId);
    return input.initiatorAutomation === 'custom_automation' && externalId
      ? `${AUTOMATION_CREATOR_FILTER_PREFIX}${input.initiatorAutomation}:${encodeURIComponent(externalId)}`
      : `${AUTOMATION_CREATOR_FILTER_PREFIX}${input.initiatorAutomation}`;
  }

  if (input.initiatorUserId) {
    return input.initiatorUserId;
  }

  const externalId = normalizeExternalActorId(input.actorExternalId);

  if (externalId) {
    return `${EXTERNAL_CREATOR_FILTER_PREFIX}${encodeURIComponent(externalId)}`;
  }

  return null;
}

export function parseCreatorFilterValue(
  value: string,
): ParsedCreatorFilterValue {
  if (value.startsWith(AUTOMATION_CREATOR_FILTER_PREFIX)) {
    const encoded = value.slice(AUTOMATION_CREATOR_FILTER_PREFIX.length);
    const separatorIndex = encoded.indexOf(':');
    const key =
      separatorIndex === -1 ? encoded : encoded.slice(0, separatorIndex);

    if (key) {
      if (separatorIndex === -1) {
        return { kind: 'automation', key };
      }

      try {
        const externalId = decodeURIComponent(
          encoded.slice(separatorIndex + 1),
        );
        if (externalId) {
          return { kind: 'automation', key, externalId };
        }
      } catch {
        // Fall through to the opaque user path for malformed values.
      }
    }
  }

  if (value.startsWith(EXTERNAL_CREATOR_FILTER_PREFIX)) {
    const encoded = value.slice(EXTERNAL_CREATOR_FILTER_PREFIX.length);

    let externalId: string | null = null;

    try {
      externalId = decodeURIComponent(encoded);
    } catch {
      externalId = null;
    }

    if (externalId) {
      if (externalId === LINEAR_AGENT_ACTOR_ID) {
        return { kind: 'linearAgent' };
      }

      return { kind: 'external', externalId };
    }
  }

  return { kind: 'user', userId: value };
}

// `formatAutomationLabel` now lives in `@roomote/types` so web + server-side
// stats share one implementation. Re-exported here for existing web callers.
export {
  formatAutomationAttributionLabel,
  formatAutomationLabel,
} from '@roomote/types';
