/**
 * Promptfoo prompt file that imports the actual production follow-up prompt.
 *
 * This ensures evals always test the real prompt used by the classifyFollowUp
 * service, preventing drift between what we test and what we deploy.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the production followup prompt TypeScript file
const promptFilePath = resolve(
  __dirname,
  '../../../src/server/router/prompts/followup-prompt.ts',
);

// Extract the prompt string from the TypeScript source
const sourceCode = readFileSync(promptFilePath, 'utf-8');

// Extract the template literal content between backticks
const match = sourceCode.match(/export const FOLLOWUP_PROMPT = `([\s\S]*?)`;/);
if (!match?.[1]) {
  throw new Error(
    `Could not extract FOLLOWUP_PROMPT from ${promptFilePath}. ` +
      'Ensure the prompt is exported as a template literal string.',
  );
}

const FOLLOWUP_PROMPT = match[1];

interface PromptVars {
  suggestedWorkspace?: string;
  userResponse?: string;
  context?: string;
}

interface PromptInput {
  vars: PromptVars;
}

// Build context from variables
function buildContext(vars: PromptVars): string {
  // If context is already provided, use it directly
  if (vars.context) {
    return vars.context;
  }

  // Build context from structured variables
  const parts: string[] = [];

  if (vars.suggestedWorkspace) {
    parts.push(`**Workspace Suggestion**: ${vars.suggestedWorkspace}`);
  }

  if (vars.userResponse) {
    parts.push(`**User Response**: ${vars.userResponse}`);
  }

  return parts.join('\n');
}

// Export a function that receives variables and returns the prompt
// This is the format expected by promptfoo for .js/.ts prompt files
export default function generatePrompt({ vars }: PromptInput): string {
  const context = buildContext(vars);

  return `${FOLLOWUP_PROMPT}

## Current Request

${context}`;
}
