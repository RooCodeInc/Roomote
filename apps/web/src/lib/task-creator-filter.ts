import {
  TASK_ATTRIBUTION_SOURCE_KINDS,
  type TaskAttributionSourceKind,
} from '@roomote/types';

const UNLINKED_CREATOR_FILTER_PREFIX = 'unlinked:';
const AUTOMATION_CREATOR_FILTER_PREFIX = 'automation:';

/** Shared bucket for automation-initiated tasks without a specific name. */
export const AUTOMATIONS_CREATOR_FILTER_VALUE = 'automations';
export const AUTOMATIONS_CREATOR_FILTER_LABEL = 'Automations';

type ParsedCreatorFilterValue =
  | {
      kind: 'automations';
    }
  | {
      kind: 'automation';
      label: string;
    }
  | {
      kind: 'matched_user';
      userId: string;
    }
  | {
      kind: 'unlinked_user';
      sourceKind: TaskAttributionSourceKind;
      sourceExternalId: string;
    };

export function buildMatchedUserCreatorFilterValue(userId: string): string {
  return userId;
}

export function buildUnlinkedCreatorFilterValue(input: {
  attributionSourceKind: TaskAttributionSourceKind | null | undefined;
  attributionSourceExternalId: string | null | undefined;
}): string | null {
  if (!input.attributionSourceKind || !input.attributionSourceExternalId) {
    return null;
  }

  return `${UNLINKED_CREATOR_FILTER_PREFIX}${input.attributionSourceKind}:${encodeURIComponent(
    input.attributionSourceExternalId,
  )}`;
}

export function buildAutomationCreatorFilterValue(label: string): string {
  return `${AUTOMATION_CREATOR_FILTER_PREFIX}${encodeURIComponent(label)}`;
}

export function parseCreatorFilterValue(
  value: string,
): ParsedCreatorFilterValue {
  if (value === AUTOMATIONS_CREATOR_FILTER_VALUE) {
    return {
      kind: 'automations',
    };
  }

  if (value.startsWith(AUTOMATION_CREATOR_FILTER_PREFIX)) {
    let label: string;

    try {
      label = decodeURIComponent(
        value.slice(AUTOMATION_CREATOR_FILTER_PREFIX.length),
      );
    } catch {
      label = '';
    }

    if (label) {
      return {
        kind: 'automation',
        label,
      };
    }

    return {
      kind: 'automations',
    };
  }

  if (!value.startsWith(UNLINKED_CREATOR_FILTER_PREFIX)) {
    return {
      kind: 'matched_user',
      userId: value,
    };
  }

  const encodedValue = value.slice(UNLINKED_CREATOR_FILTER_PREFIX.length);
  const separatorIndex = encodedValue.indexOf(':');

  if (separatorIndex === -1) {
    return {
      kind: 'matched_user',
      userId: value,
    };
  }

  const sourceKind = encodedValue.slice(
    0,
    separatorIndex,
  ) as TaskAttributionSourceKind;

  let sourceExternalId: string;

  try {
    sourceExternalId = decodeURIComponent(
      encodedValue.slice(separatorIndex + 1),
    );
  } catch {
    return {
      kind: 'matched_user',
      userId: value,
    };
  }

  if (
    !TASK_ATTRIBUTION_SOURCE_KINDS.includes(sourceKind) ||
    !sourceExternalId
  ) {
    return {
      kind: 'matched_user',
      userId: value,
    };
  }

  return {
    kind: 'unlinked_user',
    sourceKind,
    sourceExternalId,
  };
}
