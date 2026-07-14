/**
 * Promptfoo prompt file that imports the actual production prompt.
 *
 * This ensures evals always test the real prompt used by the router service,
 * preventing drift between what we test and what we deploy.
 */

import { buildWorkspaceRoutingPrompt } from '../../../src/server/router/prompts/routing-prompt';
import { NO_MODEL_MENTIONED_VALUE } from '../../../src/server/router/routing-resolution';
import {
  DEFAULT_TASK_MODEL_SETTINGS,
  getEnabledTaskModels,
} from '@roomote/types';

interface Agent {
  name: string;
  type: string;
  id: string;
}

interface Repository {
  fullName: string;
  description?: string;
}

interface Environment {
  name: string;
  description?: string;
  repositoryNames?: string[];
}

interface ExtraModel {
  displayName: string;
  id: string;
}

interface PromptVars {
  context?: string;
  taskDescription?: string;
  agents?: Agent[];
  repositories?: (string | Repository)[];
  environments?: Environment[];
  extraModels?: ExtraModel[];
}

interface PromptInput {
  vars: PromptVars;
}

// Helper to format agents list with IDs
function formatAgents(agents?: Agent[]): string {
  if (!agents || agents.length === 0) return '';
  const lines = agents.map((a) => `- ${a.type} [id: ${a.id}]`);
  return `**Available Agents**:\n${lines.join('\n')}`;
}

// Helper to format repositories list
function formatRepositories(repos?: (string | Repository)[]): string {
  if (!repos || repos.length === 0) return '';
  const lines = repos.map((r) => {
    if (typeof r === 'string') return `- ${r}`;
    return r.description
      ? `- ${r.fullName}: ${r.description}`
      : `- ${r.fullName}`;
  });
  return `**Available Repositories**:\n${lines.join('\n')}`;
}

// Helper to format environments list
function formatEnvironments(envs?: Environment[]): string {
  if (!envs || envs.length === 0) return '';
  const lines = envs.map((e) => {
    const repoList = e.repositoryNames
      ? ` (repos: ${e.repositoryNames.join(', ')})`
      : '';
    return e.description
      ? `- ${e.name}: ${e.description}${repoList}`
      : `- ${e.name}${repoList}`;
  });
  return `**Available Environments**:\n${lines.join('\n')}`;
}

// Build context from structured variables if context is not provided
function buildContext(vars: PromptVars): string {
  // If context is already provided, use it directly
  if (vars.context) {
    return vars.context;
  }

  // Build context from structured variables
  const parts: string[] = [];

  if (vars.taskDescription) {
    parts.push(`**Task Description**:\n${vars.taskDescription}`);
  }

  const agents = formatAgents(vars.agents);

  if (agents) {
    parts.push(agents);
  }

  const repos = formatRepositories(vars.repositories);

  if (repos) {
    parts.push(repos);
  }

  const envs = formatEnvironments(vars.environments);

  if (envs) {
    parts.push(envs);
  }

  return parts.join('\n\n');
}

// Build the Available Models section from the shipped default catalog so evals
// exercise the same model-selection surface production exposes to the router.
// Tests can append custom deployment-added models (like the ones organizations
// add from the settings UI) through the `extraModels` var.
function buildAvailableModelsSection(extraModels?: ExtraModel[]): string {
  const models: Array<{ displayName: string; id: string }> = [
    ...getEnabledTaskModels(DEFAULT_TASK_MODEL_SETTINGS),
    ...(extraModels ?? []),
  ];

  if (models.length === 0) {
    return '';
  }

  const lines = models.map((m) => `- ${m.displayName} [id: ${m.id}]`);

  lines.push(
    `- No model mentioned [id: ${NO_MODEL_MENTIONED_VALUE}] (choose this when the user does not name a model)`,
  );

  return `\n**Available Models**:\n${lines.join('\n')}`;
}

// Production routes through `generateObject` with `workspaceResponseSchema`,
// which carries the response shape and per-field descriptions. Promptfoo sends
// the raw text prompt instead, so evals restate that response contract here to
// keep the eval output parseable by the JSON assertions.
const OUTPUT_FORMAT_SECTION = `## Output Format

Respond with a single JSON object containing exactly these fields:

- "workspaceValue" (string): Name of the chosen environment.
- "reasoning" (string): Brief explanation of your workspace decision.
- "confidence" (number): Confidence in the workspace choice from 0 to 1.
- "kickoffMessage" (string or null): Full short user-facing kickoff sentence (about 8-18 words). Naturally include the chosen environment name, and naturally include the model display name when requestedModelId is a real model. Vary wording; no "Getting started on your task in…" boilerplate every time. No emojis, markdown, quotes, mentions, or trailing period.
- "needsExternalLookup" (boolean): Whether an external reference must be fetched before routing, per the external lookup rules.
- "externalReference" (string or null): The exact external reference to fetch when needsExternalLookup is true, otherwise null.
- "requestedModelId" (string or null): The model id the user explicitly requested from the Available Models list, or the literal "${NO_MODEL_MENTIONED_VALUE}" when the user does not name a model.
- "modelConfidence" (number or null): Confidence from 0 to 1 in your requestedModelId choice.`;

// Export a function that receives variables and returns the prompt
// This is the format expected by promptfoo for .js/.ts prompt files
export default function generatePrompt({ vars }: PromptInput): string {
  const context = buildContext(vars);
  const availableModels = buildAvailableModelsSection(vars.extraModels);
  const routingPrompt = buildWorkspaceRoutingPrompt();

  return `${routingPrompt}

${OUTPUT_FORMAT_SECTION}

## Current Request

${context}${availableModels ? `\n${availableModels}` : ''}`;
}
