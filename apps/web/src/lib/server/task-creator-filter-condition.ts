import { PRODUCT_NAME } from '@roomote/types';
import { and, eq, isNull, or, tasks, type SQL } from '@roomote/db/server';

import {
  AUTOMATIONS_CREATOR_FILTER_LABEL,
  parseCreatorFilterValue,
} from '@/lib/task-creator-filter';

/**
 * Tasks initiated by an automation rather than a human: either the authorship
 * rules resolved the effective author to the product, or no authorship rules
 * ran and the attribution snapshot is `automatic`.
 */
export function automationInitiatedTaskCondition(): SQL {
  return or(
    eq(tasks.effectiveAuthorKind, 'roomote'),
    and(
      isNull(tasks.effectiveAuthorKind),
      eq(tasks.attributionKind, 'automatic'),
    ),
  )!;
}

/**
 * Automation-initiated tasks that carry no specific automation name and land
 * in the shared "Automations" bucket. Mirrors the analytics user-dimension
 * bucketing in `analytics-task-user-dimension.ts`.
 */
function unnamedAutomationCondition(): SQL {
  return or(
    isNull(tasks.attributionSourceDisplayName),
    eq(tasks.attributionSourceDisplayName, ''),
    eq(tasks.attributionSourceDisplayName, PRODUCT_NAME),
    eq(tasks.attributionSourceDisplayName, AUTOMATIONS_CREATOR_FILTER_LABEL),
  )!;
}

/**
 * Canonical SQL predicate for a task "creator" filter value: a matched
 * product user, an unlinked external identity, a named automation, or the
 * shared Automations bucket.
 */
export function buildTaskCreatorFilterCondition(value: string): SQL {
  const creatorFilter = parseCreatorFilterValue(value);

  switch (creatorFilter.kind) {
    case 'automations':
      return and(
        automationInitiatedTaskCondition(),
        unnamedAutomationCondition(),
      )!;
    case 'automation':
      return and(
        automationInitiatedTaskCondition(),
        eq(tasks.attributionSourceDisplayName, creatorFilter.label),
      )!;
    case 'unlinked_user':
      return and(
        eq(tasks.attributionKind, 'unlinked_user'),
        or(
          isNull(tasks.effectiveAuthorKind),
          and(
            eq(tasks.effectiveAuthorKind, 'human'),
            isNull(tasks.effectiveAuthorUserId),
          ),
        ),
        eq(tasks.attributionSourceKind, creatorFilter.sourceKind),
        eq(tasks.attributionSourceExternalId, creatorFilter.sourceExternalId),
      )!;
    case 'matched_user':
      return or(
        and(
          eq(tasks.effectiveAuthorKind, 'human'),
          eq(tasks.effectiveAuthorUserId, creatorFilter.userId),
        ),
        and(
          isNull(tasks.effectiveAuthorKind),
          eq(tasks.attributedUserId, creatorFilter.userId),
        ),
      )!;
  }
}
