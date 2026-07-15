import { z } from 'zod';

import type { RoutingContext, RoutingWorkspace } from './types';

const WORKSPACE_SELECTION_PREFIX = /^(workspace|environment)\s*:\s*/i;
const WORKSPACE_SELECTION_WRAPPERS = /^[`"'([{]+|[`"')\]}]+$/g;

/**
 * Sentinel model id the router LLM must return when the user did not name a
 * model. Forcing an explicit "no model mentioned" choice instead of a nullable
 * field makes small routing models less likely to autofill a hallucinated
 * model preference.
 */
export const NO_MODEL_MENTIONED_VALUE = '__no_model__';

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
  workspaceValue: z.string().describe('Name of the chosen environment.'),
  reasoning: z
    .string()
    .describe('Brief explanation of your workspace decision'),
  confidence: confidenceField,
  kickoffMessage: z
    .string()
    .nullable()
    .describe(
      'Full short user-facing kickoff sentence posted in chat (about 8-18 words). Naturally include the exact chosen environment name, and when requestedModelId is a real model also naturally include that model display name from the Available Models list. Vary the wording; do not always use "Getting started on your task in…". End with a single period. No emojis, markdown, quotes, or mentions. Always provide a non-empty value for real routed tasks.',
    )
    .optional()
    .default(null),
  needsExternalLookup: needsExternalLookupField.optional().default(false),
  externalReference: externalReferenceField.optional().default(null),
  requestedModelId: z
    .string()
    .nullable()
    .describe(
      `The model ID the user explicitly requested, chosen from the Available Models list, or the literal "${NO_MODEL_MENTIONED_VALUE}" when the user does not name a model. Always make this an explicit choice: pick a listed model id only when the user expresses a model preference, and pick "${NO_MODEL_MENTIONED_VALUE}" otherwise.`,
    )
    .optional()
    .default(null),
  modelConfidence: z
    .number()
    .nullable()
    .describe(
      `Confidence from 0 to 1 in your requestedModelId choice. Always provide a number. When requestedModelId is a model id, this is your confidence that the user explicitly requested that model; picks below 0.9 are ignored. When requestedModelId is "${NO_MODEL_MENTIONED_VALUE}", this is your confidence that the user did not request a model.`,
    )
    .optional()
    .default(null),
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

  const normalizedSelection = normalizeWorkspaceSelectionValue(value);
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
