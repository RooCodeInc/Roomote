import {
  type EffectiveAuthorKind,
  TASK_ATTRIBUTION_SOURCE_KINDS,
  type TaskAttributionKind,
  type TaskAttributionSourceKind,
} from '@roomote/types';

const UNLINKED_CREATOR_FILTER_PREFIX = 'unlinked:';
export const ROOMOTE_CREATOR_FILTER_VALUE = 'author:roomote';

type ParsedCreatorFilterValue =
  | {
      kind: 'roomote';
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

export function buildCreatorFilterValue(input: {
  effectiveAuthorKind?: EffectiveAuthorKind | null | undefined;
  userId?: string | null | undefined;
  attributionKind: TaskAttributionKind | null | undefined;
  attributionSourceKind: TaskAttributionSourceKind | null | undefined;
  attributionSourceExternalId: string | null | undefined;
}): string | null {
  if (input.effectiveAuthorKind === 'roomote') {
    return ROOMOTE_CREATOR_FILTER_VALUE;
  }

  if (input.userId) {
    return input.userId;
  }

  if (
    input.attributionKind === 'unlinked_user' &&
    input.attributionSourceKind &&
    input.attributionSourceExternalId
  ) {
    return `${UNLINKED_CREATOR_FILTER_PREFIX}${input.attributionSourceKind}:${encodeURIComponent(
      input.attributionSourceExternalId,
    )}`;
  }

  return null;
}

export function parseCreatorFilterValue(
  value: string,
): ParsedCreatorFilterValue {
  if (value === ROOMOTE_CREATOR_FILTER_VALUE) {
    return {
      kind: 'roomote',
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
