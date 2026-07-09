/**
 * Task creator filter encoding.
 *
 * Filter values encode the task initiator columns in a flat two-part scheme
 * (no attribution cascade):
 *
 * - `<userId>`                        linked human initiator (initiatorUserId)
 * - `automation:<key>`                automation initiator (initiatorAutomation)
 * - `external:<encoded externalId>`   unlinked external human actor
 *                                     (initiatorKind 'user' + actorExternalId)
 */

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
    }
  | {
      kind: 'external';
      externalId: string;
    };

export function buildCreatorFilterValue(input: {
  initiatorKind: 'user' | 'automation' | null | undefined;
  initiatorUserId: string | null | undefined;
  initiatorAutomation: string | null | undefined;
  actorExternalId: string | null | undefined;
}): string | null {
  if (input.initiatorKind === 'automation') {
    return input.initiatorAutomation
      ? `${AUTOMATION_CREATOR_FILTER_PREFIX}${input.initiatorAutomation}`
      : null;
  }

  if (input.initiatorUserId) {
    return input.initiatorUserId;
  }

  if (input.actorExternalId) {
    return `${EXTERNAL_CREATOR_FILTER_PREFIX}${encodeURIComponent(
      input.actorExternalId,
    )}`;
  }

  return null;
}

export function parseCreatorFilterValue(
  value: string,
): ParsedCreatorFilterValue {
  if (value.startsWith(AUTOMATION_CREATOR_FILTER_PREFIX)) {
    const key = value.slice(AUTOMATION_CREATOR_FILTER_PREFIX.length);

    if (key) {
      return { kind: 'automation', key };
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
      return { kind: 'external', externalId };
    }
  }

  return { kind: 'user', userId: value };
}

/**
 * Humanizes an automation key for display, e.g. `pr_review` -> "PR Review",
 * `mcp_recommendations` -> "MCP Recommendations".
 */
const AUTOMATION_LABEL_ACRONYMS = new Set(['pr', 'ci', 'mcp']);

export function formatAutomationLabel(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) =>
      AUTOMATION_LABEL_ACRONYMS.has(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}
