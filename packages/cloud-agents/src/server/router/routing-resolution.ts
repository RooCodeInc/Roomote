import { z } from 'zod';

import { ALL_REPOSITORIES } from '@roomote/types';
import type { RoutingContext, RoutingWorkspace } from './types';

const WORKSPACE_SELECTION_PREFIX = /^(workspace|environment)\s*:\s*/i;
const WORKSPACE_SELECTION_WRAPPERS = /^[`"'([{]+|[`"')\]}]+$/g;

const needsExternalLookupField = z
  .boolean()
  .describe(
    'Set to true only when the task message contains an explicit external reference to a specific entity in an external system and the rest of the message is too underspecified to route without fetching it first. External references include specific issue or ticket IDs like LIN-123 or ENG-456 or GitHub issue or pull request numbers like #123. Do not treat general URLs, file paths, code snippets, feature names, or other task context as external references.',
  );

const externalReferenceField = z
  .string()
  .nullable()
  .describe(
    'The specific external reference to fetch when needsExternalLookup is true, such as LIN-123, ENG-456, or #123. Return null when no external lookup is required.',
  );

const confidenceField = z
  .number()
  .describe(
    'Confidence in the workspace choice as a number from 0 to 1. Use higher values when the task clearly points to one environment or explicitly names it, and lower values when the task is ambiguous or multiple environments are plausible.',
  );

/**
 * Zod schema for structured LLM workspace responses.
 * Used when agent routing is fixed in code and the LLM only needs to
 * choose the workspace dimension.
 */
export const workspaceResponseSchema = z.object({
  workspaceValue: z
    .string()
    .describe(
      'Name of the chosen environment or an available workspace value.',
    ),
  reasoning: z
    .string()
    .describe('Brief explanation of your workspace decision'),
  confidence: confidenceField,
  kickoffMessage: z
    .string()
    .nullable()
    .describe(
      'Short user-facing kickoff sentence posted in chat (about 8-18 words) that ends with a period. Naturally include the exact chosen environment name. Vary the wording; do not always use "Getting started on your task in…". No emojis, markdown, quotes, or mentions. Always provide a non-empty value for real routed tasks.',
    )
    .optional()
    .default(null),
  needsExternalLookup: needsExternalLookupField.optional().default(false),
  externalReference: externalReferenceField.optional().default(null),
});

/**
 * Maps the workspace from the LLM response to a RoutingWorkspace.
 */
export function normalizeWorkspaceSelectionValue(value: string): string {
  return value
    .trim()
    .replace(WORKSPACE_SELECTION_PREFIX, '')
    .trim()
    .replace(WORKSPACE_SELECTION_WRAPPERS, '')
    .trim();
}

function normalizeEnvironmentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function mapWorkspace(
  value: string,
  context: RoutingContext,
): RoutingWorkspace | null {
  const normalizedSelection = normalizeWorkspaceSelectionValue(value);
  if (
    context.routingRules?.some((rule) => rule.target === ALL_REPOSITORIES) &&
    (normalizedSelection === ALL_REPOSITORIES ||
      normalizedSelection.toLowerCase() === 'all repositories')
  ) {
    return { type: 'all_repositories' };
  }

  const exactMatch = context.availableEnvironments.find(
    (candidate) => candidate.name.toLowerCase() === value.trim().toLowerCase(),
  );

  if (exactMatch) {
    return {
      type: 'environment',
      id: exactMatch.id,
      name: exactMatch.name,
    };
  }

  const normalizedValue = normalizeEnvironmentName(normalizedSelection);
  const normalizedMatch = context.availableEnvironments.find(
    (candidate) => normalizeEnvironmentName(candidate.name) === normalizedValue,
  );

  if (normalizedMatch) {
    return {
      type: 'environment',
      id: normalizedMatch.id,
      name: normalizedMatch.name,
    };
  }

  return null;
}

export function wasWorkspaceRemapped(
  workspaceValue: string,
  workspace: RoutingWorkspace | null,
): boolean {
  if (workspace?.type !== 'environment') {
    return true;
  }

  if (
    workspaceValue.trim().toLowerCase() === workspace.name.trim().toLowerCase()
  ) {
    return false;
  }

  return (
    normalizeEnvironmentName(
      normalizeWorkspaceSelectionValue(workspaceValue),
    ) !== normalizeEnvironmentName(workspace.name)
  );
}
